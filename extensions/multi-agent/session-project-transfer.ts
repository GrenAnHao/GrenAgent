// 会话族迁移的子代理登记 / 活动 / drain 适配层（宿主迁移 owner 唯一入口）。
//
// 职责边界：
//   - 记录级 registry 差异：全量读某项目的子代理登记（不用 UI 的 50 / 500 条上限），
//     按行做前后向 CAS，不复制项目数据库、不碰别的会话的记录。
//   - registry 族闭包：从主会话 id 沿 parentId 与「子会话文件名里的 sessionId」闭包出全部子孙，
//     供 owner 生成 before/after 与 journal 差异。
//   - 活动保护：只认真实结算与真实运行状态；回复完成但等待后台命令、停止未确认、
//     仍在跑的 Activation / worker / 后台 job 一律拒绝，不替用户取消。
//   - drain：只释放本族已结算的驻留会话（内存里的子会话），不发结算通知、不改终态、
//     不调用整项目 shutdown，因此不会影响源项目其他会话。
//
// 与 core（electron/app/sessionProjectTransfer.ts）约定的 JSON 形状：
//   TransferRegistryRow  /  TransferRegistryDiff（见下），hash helper 由本模块导出，
//   journal 直接传 `transferRegistryRowsHash(rows)`，避免两边各写一套指纹。

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "../_shared/sqlite.js";
import {
  getActivation,
  getActivationBySessionPath,
  disposeResidentForTransfer,
  hasUnsettledRetiringResident,
  residentChildIds,
  residentIsIdle,
  retiringResidentIds,
} from "./activation.js";
import { readSubagentBashState } from "./background-bash.js";
import { runningChildrenOf } from "./child-runs.js";
import { jobs } from "../jobs/service.js";
import { ensureSubAgentRegistrySchema } from "./registry-schema.js";

/** 一行子代理登记的可迁移快照。字段与 registry 表列一一对应；bashState 保持原始 JSON 字符串。 */
export interface TransferRegistryRow {
  id: string;
  task: string;
  profile: string | null;
  model: string | null;
  thinkingLevel: string | null;
  status: string;
  output: string | null;
  error: string | null;
  exitCode: number | null;
  transcript: string | null;
  sessionPath: string | null;
  parentId: string | null;
  depth: number;
  jobId: string | null;
  bashState: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 一次迁移的 registry 记录级差异。`remove` 是源项目要退出的记录，`create` 是目标项目要出现的记录；
 * 移动时两者内容相同（保留 id / parentId / sessionPath），只是所在项目库不同。
 * `expectedSourceHash` 是 `remove` 行在准备时算出的指纹（`expectedTargetHash` 同口径对应 target 既有行），
 * 与 core journal 的 `sha256Text(stableJson(rows))` 完全一致。rollback 不走反指纹猜谜：
 * 目标侧只删除本操作真正插入过的行（见 `applyTransferRegistryDiff` 的插入标记）。
 */
export interface TransferRegistryDiff {
  operationId: string;
  sourceWorkspace: string;
  targetWorkspace: string;
  remove: TransferRegistryRow[];
  create: TransferRegistryRow[];
  expectedSourceHash: string;
  /** 可选：目标既有本族行在准备时的指纹；提供时正向 apply 前复核。 */
  expectedTargetHash?: string;
}

export interface TransferFamilyMemberRef {
  sessionPath: string;
  /** 主会话 / 子会话的 sessionId；用于 parentId → 子孙闭包与 job owner 查询。 */
  sessionId?: string;
  /** 子代理登记 id（主会话没有）。 */
  agentId?: string | null;
  /** 该成员登记所在的项目（缺省时由 owner 用源项目补）。 */
  workspace?: string;
}

export interface TransferRegistrySnapshot {
  rows: TransferRegistryRow[];
  /** 与 rows 同口径的稳定指纹；journal 直接持久化。 */
  hash: string;
}

export class TransferRegistryConflictError extends Error {
  readonly code = "SESSION_TRANSFER_REGISTRY_CONFLICT";
  constructor(readonly ids: string[], message: string) {
    super(`${message}: ${ids.join(", ")}`);
    this.name = "TransferRegistryConflictError";
  }
}

// ---- 路径与 schema ----

export function transferRegistryPath(workspace: string): string {
  return join(workspace, ".pi", "subagents", "registry.db");
}

function hasSubagentsTable(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subagents'").get());
}

function columnNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("PRAGMA table_info(subagents)").all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => row.name ?? ""));
}

/** 只读打开登记库；文件不存在时返回 undefined，不顺手建库。 */
function openReadOnly(workspace: string): DatabaseSync | undefined {
  const path = transferRegistryPath(workspace);
  if (!existsSync(path)) return undefined;
  return new DatabaseSync(path);
}

/** 可写打开：目标项目第一次接子代理时按同一 schema 建库；不做 reapOrphans 之类会改别人记录的收尾。 */
function openWritable(workspace: string): DatabaseSync {
  const path = transferRegistryPath(workspace);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  ensureSubAgentRegistrySchema(db);
  ensureTransferInsertMarkers(db);
  return db;
}

/**
 * 记录「这一行是本迁移操作插进目标库的」。rollback 只依据它删除目标侧记录，
 * 因此目标项目原本就存在的相同行（幂等往返、旧版本遗留）不会被误删。
 *
 * 表格式（与 registry 同库、同事务提交；不是 registry 语义，UI / 队列不读）：
 *   CREATE TABLE session_transfer_registry_inserts (
 *     operationId TEXT NOT NULL,   -- 迁移 journal 的 operationId（UUID）
 *     id          TEXT NOT NULL,   -- registry 行 id
 *     PRIMARY KEY (operationId, id)
 *   )
 * 为什么需要：目标项目里可能本来就有一模一样的行（重复移动 / 手工登记）。仅凭
 * 「目标有这行」无法区分「本操作插入」与「本来就在」，而 rollback 误删别人的记录
 * 是不可恢复的数据丢失。幂等 apply 不重复插入，也不重复写标记。
 */
const TRANSFER_INSERT_MARKERS = "session_transfer_registry_inserts";

function ensureTransferInsertMarkers(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${TRANSFER_INSERT_MARKERS} (
       operationId TEXT NOT NULL,
       id TEXT NOT NULL,
       PRIMARY KEY (operationId, id)
     );`,
  );
}

function recordInsertMarkers(db: DatabaseSync, operationId: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${TRANSFER_INSERT_MARKERS}(operationId, id) VALUES(?, ?)`);
  for (const id of ids) stmt.run(operationId, id);
}

function insertedByOperation(db: DatabaseSync, operationId: string, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const stmt = db.prepare(`SELECT id FROM ${TRANSFER_INSERT_MARKERS} WHERE operationId=? AND id IN (${ids.map(() => "?").join(", ")})`);
  for (const row of stmt.all(operationId, ...ids) as Array<{ id?: unknown }>) {
    if (typeof row.id === "string") out.add(row.id);
  }
  return out;
}

function clearInsertMarkers(db: DatabaseSync, operationId: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  db.prepare(`DELETE FROM ${TRANSFER_INSERT_MARKERS} WHERE operationId=? AND id IN (${ids.map(() => "?").join(", ")})`).run(
    operationId,
    ...ids,
  );
}

// ---- 行归一 / 指纹 ----

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** DB 行 → 可迁移快照；列可能来自旧库（缺列），缺的一律按 null / 0。 */
export function toTransferRegistryRow(raw: Record<string, unknown>): TransferRegistryRow {
  return {
    id: asString(raw.id),
    task: asString(raw.task),
    profile: asNullableString(raw.profile),
    model: asNullableString(raw.model),
    thinkingLevel: asNullableString(raw.thinkingLevel),
    status: asString(raw.status),
    output: asNullableString(raw.output),
    error: asNullableString(raw.error),
    exitCode: asNullableNumber(raw.exitCode),
    transcript: asNullableString(raw.transcript),
    sessionPath: asNullableString(raw.sessionPath),
    parentId: asNullableString(raw.parentId),
    depth: asNumber(raw.depth),
    jobId: asNullableString(raw.jobId),
    bashState: asNullableString(raw.bashState),
    createdAt: asNumber(raw.createdAt),
    updatedAt: asNumber(raw.updatedAt),
  };
}

/** 固定字段顺序的规范形状；hash 与逐项比较都以它为准。 */
export function canonicalTransferRegistryRow(row: TransferRegistryRow): TransferRegistryRow {
  return {
    id: row.id,
    task: row.task,
    profile: row.profile ?? null,
    model: row.model ?? null,
    thinkingLevel: row.thinkingLevel ?? null,
    status: row.status,
    output: row.output ?? null,
    error: row.error ?? null,
    exitCode: row.exitCode ?? null,
    transcript: row.transcript ?? null,
    sessionPath: row.sessionPath ?? null,
    parentId: row.parentId ?? null,
    depth: Number.isFinite(row.depth) ? row.depth : 0,
    jobId: row.jobId ?? null,
    bashState: row.bashState ?? null,
    createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
    updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
  };
}

function sortRows(rows: readonly TransferRegistryRow[]): TransferRegistryRow[] {
  return [...rows].map(canonicalTransferRegistryRow).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 与 core / journal 共用的 registry 指纹。
 * 算法必须与 `electron/app/sessionProjectTransferJournal.ts` 的 `sha256Text(stableJson(rows))`
 * 完全一致：行按 id 升序，对象键递归按字母序。这里不 import 宿主，而是照同一规则本地实现，
 * 避免两边各写一套指纹。
 */
export function transferRegistryRowsHash(rows: readonly TransferRegistryRow[]): string {
  return createHash("sha256").update(stableJson(sortRows(rows)), "utf8").digest("hex");
}

/**
 * core 的 `expectedTargetHash` 口径：**保持读库顺序**（createdAt, id）的数组指纹，
 * 不按 id 重排——core 是在 target 全量行上按 id 过滤后直接 stableJson 的。
 */
export function transferRegistryRowsHashInReadOrder(rows: readonly TransferRegistryRow[]): string {
  return createHash("sha256").update(stableJson(rows.map(canonicalTransferRegistryRow)), "utf8").digest("hex");
}

/** core `stableJson` 的同规则副本：数组保序、对象键递归排序。 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

export function transferRegistryRowEquals(left: TransferRegistryRow, right: TransferRegistryRow): boolean {
  return stableJson(canonicalTransferRegistryRow(left)) === stableJson(canonicalTransferRegistryRow(right));
}

function rowMapsEqual(left: Map<string, TransferRegistryRow>, right: Map<string, TransferRegistryRow>): boolean {
  if (left.size !== right.size) return false;
  for (const [id, row] of left) {
    const other = right.get(id);
    if (!other || !transferRegistryRowEquals(row, other)) return false;
  }
  return true;
}

// ---- 读 ----

function selectRows(db: DatabaseSync, where?: { ids?: string[] }): TransferRegistryRow[] {
  const cols = columnNames(db);
  const thinking = cols.has("thinkingLevel") ? "thinkingLevel" : "NULL AS thinkingLevel";
  const bash = cols.has("bashState") ? "bashState" : "NULL AS bashState";
  const parent = cols.has("parentId") ? "parentId" : "NULL AS parentId";
  const depth = cols.has("depth") ? "depth" : "0 AS depth";
  const job = cols.has("jobId") ? "jobId" : "NULL AS jobId";
  const sessionPath = cols.has("sessionPath") ? "sessionPath" : "NULL AS sessionPath";
  const transcript = cols.has("transcript") ? "transcript" : "NULL AS transcript";
  const base = `SELECT id, task, profile, model, ${thinking}, status, output, error, exitCode, ${transcript}, ${sessionPath}, ${parent}, ${depth}, ${job}, ${bash}, createdAt, updatedAt FROM subagents`;
  // 统一顺序（createdAt, id）：core 的 expectedTargetHash 取「target 全量读出后按 id 过滤」的原始顺序，
  // 这里读子集时也保持同一顺序，两边算出的数组指纹才一致。
  const rows = where?.ids
    ? db.prepare(`${base} WHERE id IN (${where.ids.map(() => "?").join(", ")}) ORDER BY createdAt ASC, id ASC`).all(...where.ids)
    : db.prepare(`${base} ORDER BY createdAt ASC, id ASC`).all();
  return (rows as Array<Record<string, unknown>>).map(toTransferRegistryRow);
}

/**
 * 全量读一个项目的子代理登记（无 limit、不截断 transcript）。
 * 项目没有登记库时返回空数组，不创建文件。
 */
export async function readTransferRegistryRows(workspace: string): Promise<TransferRegistryRow[]> {
  const db = openReadOnly(workspace);
  if (!db) return [];
  try {
    if (!hasSubagentsTable(db)) return [];
    return selectRows(db);
  } finally {
    db.close();
  }
}

export async function readTransferRegistryRowsByIds(
  workspace: string,
  ids: readonly string[],
): Promise<TransferRegistryRow[]> {
  const wanted = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (wanted.length === 0) return [];
  const db = openReadOnly(workspace);
  if (!db) return [];
  try {
    if (!hasSubagentsTable(db)) return [];
    return selectRows(db, { ids: wanted });
  } finally {
    db.close();
  }
}

/** 登记行的 sessionId 就是子会话文件名里的那一段；用它把 parentId 闭包接到下一层。 */
function sessionIdOfPath(path: string | null | undefined): string {
  const name = (path ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  return name.match(/^\d{4}-\d{2}-\d{2}T[^_]+_(.+)\.jsonl$/)?.[1] ?? "";
}

/**
 * 记录级族闭包：从主会话 sessionId 出发，沿登记行的 parentId 和子会话 sessionId 逐层收子孙。
 * 输入是**全量**行（readTransferRegistryRows），因此不受 UI 列表上限影响。
 */
export function descendantsInRegistry(
  rows: readonly TransferRegistryRow[],
  rootSessionId: string,
): TransferRegistryRow[] {
  const root = rootSessionId.trim();
  if (!root) return [];
  const owners = new Set([root]);
  const picked = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (picked.has(row.id)) continue;
      const parent = row.parentId?.trim();
      if (!parent || !owners.has(parent)) continue;
      picked.add(row.id);
      owners.add(row.id);
      const childSession = sessionIdOfPath(row.sessionPath);
      if (childSession) owners.add(childSession);
      grew = true;
    }
  }
  return rows.filter((row) => picked.has(row.id));
}

/** 从项目登记里取本族的记录级快照；行按 id 排序，hash 与 journal 同口径。 */
export async function snapshotTransferRegistryFamily(
  workspace: string,
  rootSessionId: string,
): Promise<TransferRegistrySnapshot> {
  const rows = descendantsInRegistry(await readTransferRegistryRows(workspace), rootSessionId);
  return { rows: sortRows(rows), hash: transferRegistryRowsHash(rows) };
}

/** 已知本族成员路径时收登记行：优先 parentId 闭包，再按 sessionPath 补上文件名对得上的行。 */
export async function readTransferRegistryRowsForFamily(
  workspace: string,
  rootSessionId: string,
  memberSessionPaths: readonly string[] = [],
): Promise<TransferRegistryRow[]> {
  const all = await readTransferRegistryRows(workspace);
  const byClosure = descendantsInRegistry(all, rootSessionId);
  const wanted = new Set(memberSessionPaths.map((path) => path.trim()).filter(Boolean));
  if (wanted.size === 0) return sortRows(byClosure);
  const seen = new Set(byClosure.map((row) => row.id));
  for (const row of all) {
    if (seen.has(row.id)) continue;
    const path = row.sessionPath?.trim();
    if (!path || !wanted.has(path)) continue;
    byClosure.push(row);
    seen.add(row.id);
  }
  return sortRows(byClosure);
}

// ---- 结算判定 ----

/**
 * 只有真实结算的登记行才允许迁移。
 * - running：还有回合在跑（含「回复完成 · 等待后台命令」）。
 * - background-bash-timeout：停止没有逐 job 确认的，视同未结算。
 * - done / error / cancelled 且没有未确认的 Bash 收尾：可迁移，状态原样保留，不改成别的终态。
 */
export function isSettledTransferRegistryRow(row: TransferRegistryRow): boolean {
  if (row.status === "running") return false;
  const bash = readSubagentBashState(row.bashState);
  if (!bash) return true;
  if ("phase" in bash) return false;
  return bash.jobs.every((job) => job.stopConfirmed === true);
}

export function unsettledTransferRegistryRows(rows: readonly TransferRegistryRow[]): TransferRegistryRow[] {
  return rows.filter((row) => !isSettledTransferRegistryRow(row));
}

// ---- 冲突 / 计划 ----

export interface TransferRegistryPlan {
  diff: TransferRegistryDiff;
  /** 目标项目已有同 id 但内容不同的记录：必须在提交前拒绝，不覆盖任何一方。 */
  conflicts: string[];
  warnings: string[];
}

/**
 * 生成记录级差异并做提交前检查：全部行已结算、id 不重复、目标同 id 记录要么不存在要么完全相同。
 * 不写盘。`rows` 通常来自 `snapshotTransferRegistryFamily`。
 */
export async function planTransferRegistry(input: {
  operationId: string;
  sourceWorkspace: string;
  targetWorkspace: string;
  rows: readonly TransferRegistryRow[];
}): Promise<TransferRegistryPlan> {
  const rows = sortRows(input.rows);
  const warnings: string[] = [];
  const unsettled = unsettledTransferRegistryRows(rows);
  if (unsettled.length > 0) {
    throw new TransferRegistryConflictError(
      unsettled.map((row) => row.id),
      "sub-agent registry rows are not settled",
    );
  }
  const duplicates = rows.map((row) => row.id).filter((id, index, list) => list.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new TransferRegistryConflictError(duplicates, "duplicate sub-agent registry ids in family");
  }
  const targetRows = await readTransferRegistryRowsByIds(input.targetWorkspace, rows.map((row) => row.id));
  const targetById = new Map(targetRows.map((row) => [row.id, row]));
  const conflicts: string[] = [];
  for (const row of rows) {
    const existing = targetById.get(row.id);
    if (existing && !transferRegistryRowEquals(existing, row)) conflicts.push(row.id);
  }
  if (conflicts.length > 0) {
    throw new TransferRegistryConflictError(conflicts, "target project already has conflicting sub-agent records");
  }
  return {
    diff: {
      operationId: input.operationId,
      sourceWorkspace: input.sourceWorkspace,
      targetWorkspace: input.targetWorkspace,
      remove: rows,
      create: rows,
      expectedSourceHash: transferRegistryRowsHash(rows),
    },
    conflicts,
    warnings,
  };
}

// ---- 写 ----

interface RowWrite {
  db: DatabaseSync;
  insert: (row: TransferRegistryRow) => void;
  remove: (id: string) => void;
}

function writerFor(db: DatabaseSync): RowWrite {
  return {
    db,
    insert(row) {
      db.prepare(
        "INSERT INTO subagents(id, task, profile, model, thinkingLevel, status, output, error, exitCode, transcript, sessionPath, parentId, depth, jobId, bashState, createdAt, updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        row.id,
        row.task,
        row.profile,
        row.model,
        row.thinkingLevel,
        row.status,
        row.output,
        row.error,
        row.exitCode,
        row.transcript,
        row.sessionPath,
        row.parentId,
        row.depth,
        row.jobId,
        row.bashState,
        row.createdAt,
        row.updatedAt,
      );
    },
    remove(id) {
      db.prepare("DELETE FROM subagents WHERE id=?").run(id);
    },
  };
}

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务已经结束 */
    }
    throw error;
  }
}

/**
 * 按记录做 CAS 后把差异写进目标、从源退出。幂等：重放时若源已无 remove、目标已逐项等于 create，
 * 直接返回（journal 重复提交不会多写一行）。
 *
 * - 源侧：`remove` 的每个 id 必须在源项目存在且逐项相等，且整体 hash 等于 expectedSourceHash。
 * - 目标侧：`create` 的每个 id 必须不存在或逐项相等；不同即冲突，不覆盖未知数据。
 * - 不整库替换、不删其他会话的记录，不回收 transcript。
 */
export async function applyTransferRegistryDiff(diff: TransferRegistryDiff): Promise<{ applied: boolean }> {
  const remove = sortRows(diff.remove);
  const create = sortRows(diff.create);
  const ids = [...new Set([...remove.map((row) => row.id), ...create.map((row) => row.id)])];
  const unsettled = unsettledTransferRegistryRows([...remove, ...create]);
  if (unsettled.length > 0) {
    throw new TransferRegistryConflictError(unsettled.map((row) => row.id), "refuse to move unsettled sub-agent rows");
  }

  const sourceRows = await readTransferRegistryRowsByIds(diff.sourceWorkspace, remove.map((row) => row.id));
  const targetRows = await readTransferRegistryRowsByIds(diff.targetWorkspace, create.map((row) => row.id));
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  const targetById = new Map(targetRows.map((row) => [row.id, row]));

  const targetConflict = create.filter((row) => {
    const existing = targetById.get(row.id);
    return existing !== undefined && !transferRegistryRowEquals(existing, row);
  });
  if (targetConflict.length > 0) {
    throw new TransferRegistryConflictError(targetConflict.map((row) => row.id), "target records changed");
  }

  // 已应用：源侧全部退出、目标侧逐项到位。
  const alreadyApplied =
    remove.every((row) => !sourceById.has(row.id)) &&
    create.every((row) => {
      const existing = targetById.get(row.id);
      return existing !== undefined && transferRegistryRowEquals(existing, row);
    });
  if (alreadyApplied) return { applied: false };

  const expected = new Map(remove.map((row) => [row.id, row]));
  if (!rowMapsEqual(sourceById, expected)) {
    const missing = remove.filter((row) => {
      const current = sourceById.get(row.id);
      return !current || !transferRegistryRowEquals(current, row);
    });
    throw new TransferRegistryConflictError(missing.map((row) => row.id), "source registry rows changed");
  }
  if (transferRegistryRowsHash(sourceRows) !== diff.expectedSourceHash) {
    throw new TransferRegistryConflictError(ids, "source registry fingerprint mismatch");
  }

  // 目标侧准备时既有行的指纹（可选）：只对同 id 的既有行取，顺序与读库一致，不与全库耦合。
  if (diff.expectedTargetHash && transferRegistryRowsHashInReadOrder(targetRows) !== diff.expectedTargetHash) {
    throw new TransferRegistryConflictError(ids, "target registry fingerprint mismatch");
  }

  // 目标先写、源后退：目标失败时不动物源；源删除失败时撤掉本次真正新插入的目标行（原来就有的不动）。
  // 目标原本就有且逐项相等的行保持原样、不记插入标记，rollback 因此不会误删别人的记录。
  //
  // 前面的 sourceRows / targetRows 只是**乐观预检**；真正的 CAS 发生在各自事务内：
  // 外部 SQLite writer（裸 CLI、别的应用实例）可能在两次 await 之间改同 id 的行。
  const inserted = create.filter((row) => !targetById.has(row.id));
  const createById = new Map(create.map((row) => [row.id, row]));
  // 目标侧本来就有全部行时不要凭空建一个空 registry 库。
  const targetDb = inserted.length > 0 ? openWritable(diff.targetWorkspace) : undefined;
  let wroteTarget = false;
  try {
    if (targetDb) {
      const writer = writerFor(targetDb);
      inTransaction(targetDb, () => {
        // 事务内重读：把乐观预检之后出现的目标行当成冲突，而不是撞 UNIQUE。
        const current = new Map(selectRows(targetDb, { ids: inserted.map((row) => row.id) }).map((row) => [row.id, row]));
        const conflict = inserted.filter((row) => {
          const existing = current.get(row.id);
          return existing !== undefined && !transferRegistryRowEquals(existing, row);
        });
        if (conflict.length > 0) {
          throw new TransferRegistryConflictError(conflict.map((row) => row.id), "target records changed during apply");
        }
        const fresh = inserted.filter((row) => !current.has(row.id));
        for (const row of fresh) writer.insert(row);
        recordInsertMarkers(targetDb, diff.operationId, fresh.map((row) => row.id));
      });
      wroteTarget = true;
    }
    if (remove.length > 0) {
      const sourcePath = transferRegistryPath(diff.sourceWorkspace);
      if (!existsSync(sourcePath)) {
        throw new TransferRegistryConflictError(remove.map((row) => row.id), "source registry disappeared");
      }
      const sourceDb = openWritable(diff.sourceWorkspace);
      try {
        const writer = writerFor(sourceDb);
        inTransaction(sourceDb, () => {
          // 事务内重读：逐项 + 整体指纹都要仍然等于准备时的快照，才允许 DELETE。
          const current = selectRows(sourceDb, { ids: remove.map((row) => row.id) });
          const currentById = new Map(current.map((row) => [row.id, row]));
          if (!rowMapsEqual(currentById, expected)) {
            const changed = remove.filter((row) => {
              const rowNow = currentById.get(row.id);
              return !rowNow || !transferRegistryRowEquals(rowNow, row);
            });
            throw new TransferRegistryConflictError(changed.map((row) => row.id), "source registry rows changed during apply");
          }
          if (transferRegistryRowsHash(current) !== diff.expectedSourceHash) {
            throw new TransferRegistryConflictError(remove.map((row) => row.id), "source registry fingerprint changed during apply");
          }
          for (const row of remove) writer.remove(row.id);
        });
      } finally {
        sourceDb.close();
      }
    }
  } catch (error) {
    if (targetDb && wroteTarget) {
      try {
        inTransaction(targetDb, () => {
          const writer = writerFor(targetDb);
          const marked = insertedByOperation(targetDb, diff.operationId, inserted.map((row) => row.id));
          const cleared: string[] = [];
          for (const id of marked) {
            const row = createById.get(id);
            if (!row) {
              // 本操作没插入过这一行（标记是别的操作留下的）：不碰行，也不清别人的证明。
              continue;
            }
            const current = selectRows(targetDb, { ids: [id] })[0];
            if (current && !transferRegistryRowEquals(current, row)) {
              // 外部 writer 改过这一行：保留本操作的插入标记。
              // 后续若把内容恢复成我们的 create，rollback 仍能认出「这行是本操作插入的」并删掉它，
              // 否则源目标会各留一份同 id 记录。行本身留在这里不动（不覆盖未知数据）。
              continue;
            }
            writer.remove(id);
            cleared.push(id);
          }
          // 只清真正删掉 / 已经不存在的行的标记；changed 行保留，供 rollback 收口。
          clearInsertMarkers(targetDb, diff.operationId, cleared);
        });
      } catch {
        /* 回退目标失败：journal 的 after-image / 恢复流程负责收口 */
      }
    }
    throw error;
  } finally {
    targetDb?.close();
  }
  return { applied: true };
}

/**
 * 提交前失败回源：目标侧只删除**本次操作实际插入过**的行（插入标记），源侧把 `remove` 行按原样补回。
 *
 * - 目标已有且逐项相等的行（准备前就在那儿）不删、不覆盖：回滚别人原本的数据是错的。
 * - 没有任何插入标记且源侧行都还在 → 视为已回滚，返回 `{applied:false}`，重复调用安全。
 * - 目标侧行被外部改动过（与 create 不符）→ 冲突，交由 journal 标 recovery-required，不覆盖未知数据。
 */
export async function rollbackTransferRegistryDiff(diff: TransferRegistryDiff): Promise<{ applied: boolean }> {
  const remove = sortRows(diff.remove);
  const create = sortRows(diff.create);
  const targetRows = await readTransferRegistryRowsByIds(diff.targetWorkspace, create.map((row) => row.id));
  const targetById = new Map(targetRows.map((row) => [row.id, row]));
  const changed = create.filter((row) => {
    const existing = targetById.get(row.id);
    return existing !== undefined && !transferRegistryRowEquals(existing, row);
  });
  if (changed.length > 0) {
    throw new TransferRegistryConflictError(changed.map((row) => row.id), "target records changed during rollback");
  }

  const createById = new Map(create.map((row) => [row.id, row]));
  const targetDb = create.length > 0 && existsSync(transferRegistryPath(diff.targetWorkspace))
    ? openWritable(diff.targetWorkspace)
    : undefined;
  let marked = new Set<string>();
  try {
    if (targetDb) {
      inTransaction(targetDb, () => {
        // 事务内重读：预检之后被外部 writer 改过的目标行必须判冲突，不能盲删。
        marked = insertedByOperation(targetDb, diff.operationId, create.map((row) => row.id));
        const current = new Map(selectRows(targetDb, { ids: [...marked] }).map((row) => [row.id, row]));
        const changedNow = [...marked].filter((id) => {
          const row = createById.get(id);
          const rowNow = current.get(id);
          return !row || !rowNow || !transferRegistryRowEquals(rowNow, row);
        });
        if (changedNow.length > 0) {
          throw new TransferRegistryConflictError(changedNow, "target records changed during rollback");
        }
        if (marked.size === 0) return;
        const writer = writerFor(targetDb);
        for (const id of marked) writer.remove(id);
        clearInsertMarkers(targetDb, diff.operationId, [...marked]);
      });
    }
  } finally {
    targetDb?.close();
  }

  const sourceRows = remove.length > 0
    ? await readTransferRegistryRowsByIds(diff.sourceWorkspace, remove.map((row) => row.id))
    : [];
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  const changedSource = remove.filter((row) => {
    const existing = sourceById.get(row.id);
    return existing !== undefined && !transferRegistryRowEquals(existing, row);
  });
  if (changedSource.length > 0) {
    throw new TransferRegistryConflictError(changedSource.map((row) => row.id), "source records changed during rollback");
  }
  const restore = remove.filter((row) => !sourceById.has(row.id));
  if (restore.length > 0) {
    const sourceDb = openWritable(diff.sourceWorkspace);
    try {
      const writer = writerFor(sourceDb);
      inTransaction(sourceDb, () => {
        // 事务内重读：只补真正缺失的行；同 id 已被别人写成别的值就冲突。
        const current = new Map(selectRows(sourceDb, { ids: remove.map((row) => row.id) }).map((row) => [row.id, row]));
        const conflict = remove.filter((row) => {
          const existing = current.get(row.id);
          return existing !== undefined && !transferRegistryRowEquals(existing, row);
        });
        if (conflict.length > 0) {
          throw new TransferRegistryConflictError(conflict.map((row) => row.id), "source records changed during rollback restore");
        }
        for (const row of restore) if (!current.has(row.id)) writer.insert(row);
      });
    } finally {
      sourceDb.close();
    }
  }

  // 回读完整族：回滚完成必须能证明源侧逐项等于原快照（journal 的 rollback 不一定再验 registry）。
  if (remove.length > 0) {
    const finalRows = await readTransferRegistryRowsByIds(diff.sourceWorkspace, remove.map((row) => row.id));
    const finalById = new Map(finalRows.map((row) => [row.id, row]));
    const missing = remove.filter((row) => {
      const rowNow = finalById.get(row.id);
      return !rowNow || !transferRegistryRowEquals(rowNow, row);
    });
    if (missing.length > 0) {
      throw new TransferRegistryConflictError(missing.map((row) => row.id), "rollback did not restore the source family");
    }
  }
  const restored = restore.length > 0 || marked.size > 0;
  return { applied: restored };
}

/** core `TransferFamilyMember` 里本模块用到的字段（结构兼容，不 import 宿主）。 */
export interface TransferFamilyMemberLike {
  sessionPath: string;
  sessionId?: string;
  agentId?: string | null;
}

/**
 * core `TransferActivityPort.busy` 的现成实现：把 family 成员映射成本模块的活动检查。
 * core 的 owner 会先自己查运行时的 turn/queue/profile，再调这里补子代理与后台命令状态；
 * 这里只回答「族里还有没有活的子代理」。返回 undefined 表示不忙。
 */
export function transferActivityBusy(input: {
  sourceWorkspace: string;
  family: { members: readonly TransferFamilyMemberLike[] };
}): { busyReason: "subagent-unsettled"; detail: string } | undefined {
  const members: TransferFamilyMemberRef[] = input.family.members.map((member) => ({
    sessionPath: member.sessionPath,
    ...(member.sessionId ? { sessionId: member.sessionId } : {}),
    ...(member.agentId ? { agentId: member.agentId } : {}),
    workspace: input.sourceWorkspace,
  }));
  const reason = checkTransferFamilyActivity(members);
  return reason ? { busyReason: "subagent-unsettled", detail: reason } : undefined;
}

/** 把族成员映射成 drain 输入（同上，登记所在项目取源项目）。 */
export function transferFamilyRefs(input: {
  sourceWorkspace: string;
  family: { members: readonly TransferFamilyMemberLike[] };
}): TransferFamilyMemberRef[] {
  return input.family.members.map((member) => ({
    sessionPath: member.sessionPath,
    ...(member.sessionId ? { sessionId: member.sessionId } : {}),
    ...(member.agentId ? { agentId: member.agentId } : {}),
    workspace: input.sourceWorkspace,
  }));
}

/**
 * core `TransferRegistryPort` 的现成实现：`{ read, apply, rollback }`。
 * core 的 diff 形状比本模块多一个必需的 `expectedTargetHash`，因此参数用宽形状接收，
 * 返回值按 core 的 `Promise<void>` 收口（本模块的 `{applied}` 只给日志/测试用）。
 */
export const transferRegistryPort = {
  read: (workspace: string) => readTransferRegistryRows(workspace),
  apply: async (diff: TransferRegistryDiff): Promise<void> => {
    await applyTransferRegistryDiff(diff);
  },
  rollback: async (diff: TransferRegistryDiff): Promise<void> => {
    await rollbackTransferRegistryDiff(diff);
  },
};

// ---- 活动 / drain ----

function registryRowFor(member: TransferFamilyMemberRef): TransferRegistryRow | undefined {
  // 活动检查是热路径：直接读该成员所在项目的登记库（不存在即没有登记），不走全量扫描。
  const workspace = member.workspace;
  const agentId = member.agentId?.trim();
  if (!workspace || !agentId) return undefined;
  const db = openReadOnly(workspace);
  if (!db) return undefined;
  try {
    if (!hasSubagentsTable(db)) return undefined;
    const rows = selectRows(db, { ids: [agentId] });
    return rows[0];
  } finally {
    db.close();
  }
}

function memberBusyReason(member: TransferFamilyMemberRef): string | undefined {
  const agentId = member.agentId?.trim() || undefined;
  const sessionId = member.sessionId?.trim() || undefined;
  // 迁移隔离区里还有未证明收口的旧写者（上一次 drain 超时）：一律按忙处理，
  // 不能因为「已经不在驻留池」就当成空闲。
  if (agentId && hasUnsettledRetiringResident(agentId)) {
    return "子代理的旧运行环境尚未确认释放，请稍后重试";
  }
  // 进程内还在的 Activation（含 worker 后端）：这一族还有活着的子会话，不能换项目。
  if (getActivationBySessionPath(member.sessionPath)) return "子代理仍在运行，请等待本轮结束";
  if (agentId && getActivation(agentId)) return "子代理仍在运行，请等待本轮结束";
  // 本进程内仍在跑的后台子代理（wait_agent 的口径）。
  if (sessionId && runningChildrenOf(sessionId).length > 0) return "子代理仍在运行，请等待结算";
  if (agentId && runningChildrenOf(agentId).length > 0) return "子代理仍在运行，请等待结算";
  // 后台命令按 owner（会话 id / 子代理 id）归属；未知 owner 无法证明空闲。
  if (sessionId && jobs.hasLive(sessionId)) return "仍有后台命令运行，请等待任务结束";
  if (agentId && jobs.hasLive(agentId)) return "仍有后台命令运行，请等待任务结束";
  const row = registryRowFor(member);
  if (row) {
    if (row.status === "running") {
      const bash = readSubagentBashState(row.bashState);
      return bash ? "子代理回复已完成但仍在等待后台命令" : "子代理仍在运行，请等待结算";
    }
    if (!isSettledTransferRegistryRow(row)) {
      return "子代理的后台命令停止未确认，请等待结算";
    }
  }
  return undefined;
}

/**
 * 检查整个会话族的活动状态。返回 undefined 表示可以迁移；否则是给用户看的原因。
 * 只读、不加锁、不取消任何任务；状态未知按忙处理（由 owner 决定是否 fail closed）。
 */
export function checkTransferFamilyActivity(members: readonly TransferFamilyMemberRef[]): string | undefined {
  if (!Array.isArray(members) || members.length === 0) return "无法确认会话族的活动状态";
  for (const member of members) {
    const path = member.sessionPath?.trim();
    if (!path) return "无法确认会话族的活动状态";
    const reason = memberBusyReason(member);
    if (reason) return reason;
  }
  return undefined;
}

export interface TransferFamilyDrainResult {
  /** 已证明不再写会话、可以安全迁移的驻留子会话 id。 */
  drained: string[];
  /** 仍忙或无法证明已收口、未释放的 id。 */
  busy: string[];
  /** 诊断（超时 / worker 报错），只给日志与 status 用，不含历史正文。 */
  diagnostics: string[];
}

export interface TransferFamilyDrainDeps {
  residentChildIds: () => readonly string[];
  /** 同步 `disposeResident` 的异步版本：必须等宿主持有的会话真正收口才能 resolve。 */
  disposeResidentForTransfer: (childId: string, options?: { timeoutMs?: number }) => Promise<{
    confirmed: boolean;
    diagnostic?: string;
  }>;
  /** 驻留会话当前的忙碌判定（undefined 表示不在驻留池）。 */
  residentIsIdle?: (childId: string) => boolean | undefined;
  /**
   * 迁移隔离区里尚未证明收口的写者（上一次 drain 超时留下的）。
   * 它们已经不在可复用驻留池，但对迁移仍是活写者：每次 drain 都必须重新确认，不能跳过。
   */
  unsettledRetiringWriterIds?: () => readonly string[];
}

const defaultDrainDeps: TransferFamilyDrainDeps = {
  residentChildIds,
  disposeResidentForTransfer,
  residentIsIdle,
  unsettledRetiringWriterIds: () => retiringResidentIds().filter((id) => hasUnsettledRetiringResident(id)),
};

export interface TransferFamilyDrainOptions {
  /** 每个 worker 等 dispose 回执的上限；到点按 busy 报，不继续迁移。 */
  timeoutMs?: number;
  /** 测试 / 宿主替身；缺省用真实驻留池。 */
  deps?: TransferFamilyDrainDeps;
}

/**
 * 只释放本族**已结算**的驻留会话，并等它们真的停止写 JSONL。
 *
 * 为什么必须 async：worker 后端的驻留会话是代理，`dispose()` 只发 RPC 后立即返回；
 * 迁移紧接着就要改写同一份 JSONL，必须拿到 dispose 回执 / 进程退出的确认。
 *
 * 保证：
 * - 只碰本族成员，且先确认未结算（registry 行 running / waiting-for-bash / stopConfirmed!==true）就进 busy；
 * - 不写 `subagent_meta.tornDown`、不发结算通知、不改终态，不调用整项目 control-plane release，
 *   同项目其他会话的 resident / worker 不受影响；
 * - 任一成员无法证明收口（超时 / worker 报错）→ 该 id 进 `busy` 并带诊断，调用方必须按 busy 拒绝迁移；
 * - 不替用户取消任务：idle 已证明才关，关的路径与普通 settle / dispose 相同。
 */
export async function drainTransferFamily(
  members: readonly TransferFamilyMemberRef[],
  options: TransferFamilyDrainOptions = {},
): Promise<TransferFamilyDrainResult> {
  const deps = options.deps ?? defaultDrainDeps;
  const drained: string[] = [];
  const busy: string[] = [];
  const diagnostics: string[] = [];
  // 驻留池 + 上一次 drain 未确认收口的写者：后者不在池里，但仍然必须被重新确认。
  const residents = new Set([
    ...deps.residentChildIds(),
    ...(deps.unsettledRetiringWriterIds?.() ?? []),
  ]);
  for (const member of members) {
    const agentId = member.agentId?.trim();
    if (!agentId) continue;
    if (!residents.has(agentId)) continue;
    // 驻留池里的会话本身已经结算；再查一次登记行 / 运行时状态防止有人先复活它。
    const row = registryRowFor(member);
    if (row && !isSettledTransferRegistryRow(row)) {
      busy.push(agentId);
      diagnostics.push(`${agentId}: registry row is not settled`);
      continue;
    }
    if (deps.residentIsIdle?.(agentId) === false) {
      busy.push(agentId);
      diagnostics.push(`${agentId}: resident session is still busy`);
      continue;
    }
    try {
      const result = await deps.disposeResidentForTransfer(agentId, options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs });
      if (result.confirmed) drained.push(agentId);
      else {
        busy.push(agentId);
        diagnostics.push(`${agentId}: ${result.diagnostic ?? "dispose was not confirmed"}`);
      }
    } catch (error) {
      busy.push(agentId);
      diagnostics.push(`${agentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { drained, busy, diagnostics };
}
