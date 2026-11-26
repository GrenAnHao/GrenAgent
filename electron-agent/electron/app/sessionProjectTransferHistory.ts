/**
 * 会话跨项目迁移的历史 after-image 纯函数。
 *
 * 约束（见 openspec/changes/move-sessions-between-projects/design.md 第 1、5 节）：
 * - 会话 ID、header timestamp、JSONL 物理路径和全部历史行保持不变；只改 header 的项目元数据 cwd。
 * - 不 clone、不重排、不重新序列化既有 v3 行：历史正文、条目 ID、父链、全部分支、标签、压缩、
 *   context edit、思考签名、未知合法字段都按原始字节保留。
 * - 只追加版本化 `session_project_transfer`、目标 `working_directory`、可选 `session-preferences`
 *   和子会话的 `subagent_meta` 副本；追加行不改用户确认的 leaf（调用方用返回的 leafId 写位置）。
 * - 旧 v1／v2 会话先经 `strictSessionJsonl` 的 SDK 内存迁移，再一次性形成明确的 v3 after-image。
 * - 同一 operationId 重放幂等：已含该迁移记录的日志原样返回，不重复追加。
 * - 逐引用历史来源快照由共享模块确定性重放；journal 的 before/after 镜像由调用方写入。
 */
import { createHash } from 'node:crypto';
import { SessionManager } from '../../../cli/src/pi-sdk.js';
import { strictSessionJsonl } from './sessionWorkflowData.js';
import type { SessionPreferences } from '../../../extensions/_shared/session-preferences.js';
import {
  buildEntryRootProvenance,
  lastEntryIdBefore,
  parseSessionProjectTransfer,
  readSessionProjectTransfers,
  SESSION_PROJECT_TRANSFER_ENTRY,
  SESSION_PROJECT_TRANSFER_VERSION,
  SESSION_TRANSFER_PROVENANCE_VERSION,
  type SessionProjectTransferMetadata,
  type TransferProvenance,
  type TransferSourceRoot,
} from '../../../extensions/_shared/session-project-transfer.js';

export interface BuildTransferredSessionInput {
  operationId: string;
  fromWorkspace: string;
  toWorkspace: string;
  /** 迁移前确认的 leaf；null 表示空根。必须是原日志里已有的 entry id 或 null。 */
  leafId: string | null;
  /** 目标本地策略重算后的会话偏好；只记明确请求值，不复制源授权。 */
  preferences?: SessionPreferences;
  /** 宿主时间（epoch ms）；缺省 Date.now()。同一 before 重试时应传同一值以得到同一 after-image。 */
  now?: number;
  /** 子会话的 meta 覆盖；null 表示不追加，缺省时自动检测最后一条 `subagent_meta`。 */
  subagentMeta?: Record<string, unknown> | null;
  /** 迁移前整份日志的 sha256；缺省按输入 raw 计算。 */
  beforeSha256?: string;
  /** 把逐引用来源快照嵌进 metadata（journal 已有权威副本时不建议，避免 marker 膨胀）。 */
  embedProvenance?: boolean;
  /** 额外的源 scratch 保留根（例如该族子会话所在的临时对话目录）。 */
  retentionRoots?: string[];
}

export interface TransferredSession {
  /** 迁移后的完整 JSONL（before/after 镜像的 after 内容）。 */
  raw: string;
  header: Record<string, unknown>;
  entries: Record<string, unknown>[];
  metadata: SessionProjectTransferMetadata;
  provenance: TransferProvenance;
  /** 本批次追加的条目 id（按顺序）。 */
  appendedEntryIds: string[];
  /** 原确认 leaf；追加条目不会替代它。 */
  leafId: string | null;
  /** 该 operationId 已应用过：raw 未改动。 */
  alreadyApplied: boolean;
  /** 输入 raw 的 sha256。 */
  beforeSha256: string;
}

const MANAGED_SUBAGENT_PROJECT_FIELDS = ['workspace', 'cwd', 'projectCwd', 'projectRoot', 'projectRootPath'] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 确定性条目 id：同一 operationId 对同一 before 重试必须得到同一 after-image，
 * 否则 journal 的 hash 校验与幂等回执会各说各话（randomUUID 会每跑一次变一个）。
 * 长度与 UUID 一致，字符集仅 [0-9a-f-]；同一批次内 index 唯一。
 */
export function transferEntryId(operationId: string, index: number): string {
  const digest = createHash('sha256').update(`${operationId}\u0000${index}`, 'utf8').digest('hex').slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function uniqueRoots(groups: ReadonlyArray<ReadonlyArray<string> | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const root of group ?? []) {
      const trimmed = root.trim();
      if (!trimmed) continue;
      const key = trimmed.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

/** 首个换行位置、换行风格与换行后的原样正文。 */
function splitHeader(raw: string): { header: string; body: string; eol: string } {
  const nl = raw.indexOf('\n');
  if (nl === -1) return { header: raw, body: '', eol: '\n' };
  const eol = nl > 0 && raw[nl - 1] === '\r' ? '\r\n' : '\n';
  return { header: raw.slice(0, eol === '\r\n' ? nl - 1 : nl), body: raw.slice(nl + 1), eol };
}

/**
 * 迁移专用会话解析结果。
 *
 * - `header` / `entries` 是规范化后的 v3 树（ID、父链、compaction 引用均可直接用于 SDK 内存回放）。
 * - `opaque` 是合法但没有树身份的旧行（当前只有 WorkspaceService 直写的
 *   `{"type":"session_info","name":…}` 标题行；仅 v2／v3 可能出现），逐字节保留、按原顺序返回；
 *   它不参与叶/父链。v1 没有 ID 概念，所有行都按 SDK 迁移口径补 ID。
 * - v1 没有条目 ID：按 `sha256(raw + index)` 确定性赋 canonical id 与线性父链，再做 v2→v3 迁移，
 *   因此同一份 before 每次解析结果完全相同（不依赖 SDK 的随机 id 生成）。
 */
type SdkEntry = ReturnType<SessionManager['getEntries']>[number];
type SdkHeader = NonNullable<ReturnType<SessionManager['getHeader']>>;

export interface TransferSessionDocument {
  /** 规范化后的 header（v1／v2 已升到 v3 字段形状）。 */
  header: SdkHeader;
  /** 规范化后的树条目，可直接交给 `SessionManager.inMemory` 回放。 */
  entries: SdkEntry[];
  /** 合法但没有树身份的旧行（逐字节、按原顺序）。 */
  opaque: string[];
  /** 与 `opaque` 一一对应：该行之前已有多少条树条目（用于 v1／v2 after-image 保持原位置）。 */
  opaqueAt: number[];
  /** 输入文件版本（1／2／3）。 */
  version: 1 | 2 | 3;
  /** v1 输入：本次规范化为其合成了条目 ID。 */
  synthesizedIds: boolean;
}

/** 精确匹配 WorkspaceService.setSessionDisplayName 写入的标题行：只有 type 与 name。 */
function isLegacyTitleLine(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('name')) return false;
  return value.type === 'session_info' && typeof value.name === 'string' && value.name.trim().length > 0;
}

/** v1 条目 ID：同一 before 文本与位置永远得到同一个 id（UUID 形状，便于下游沿用同一正则）。 */
function deterministicLegacyId(seed: string, index: number): string {
  const hex = createHash('sha256').update(`${seed}\u0000legacy-entry\u0000${index}`, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * v1 → v2 的内存升级：补 ID 与线性父链，把 compaction 的 firstKeptEntryIndex 换成条目 ID。
 *
 * 索引口径与 SDK 的 `migrateV1ToV2` 完全一致：`firstKeptEntryIndex` 是**含 header** 的数组下标，
 * 因此 0 指向 header（不可作目标）、`n>0` 指向 `rows[n-1]`。目标必须在本条之前；越界、回指或指向
 * header 一律 fail closed，不猜目标。
 */
function upgradeLegacyEntries(
  rows: Record<string, unknown>[],
  seed: string,
): Record<string, unknown>[] {
  const ids = rows.map((row, index) => (nonEmpty(row.id) ? row.id : deterministicLegacyId(seed, index)));
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`SESSION_TRANSFER_DUPLICATE_ENTRY: ${id}`);
    seen.add(id);
  }
  const out: Record<string, unknown>[] = rows.map((row, index) => ({
    ...row,
    id: ids[index],
    parentId: index === 0 ? null : ids[index - 1],
  }));
  out.forEach((row, index) => {
    if (row.type !== 'compaction' || typeof row.firstKeptEntryIndex !== 'number') return;
    const target = row.firstKeptEntryIndex;
    // 含 header 的下标：target=0 是 header，target=n 对应 rows[n-1]；必须早于本条。
    if (!Number.isInteger(target) || target < 1 || target - 1 >= index) {
      throw new Error(`SESSION_TRANSFER_LEGACY_COMPACTION_INDEX: ${String(target)}`);
    }
    row.firstKeptEntryId = ids[target - 1];
    delete row.firstKeptEntryIndex;
  });
  return out;
}

/**
 * 迁移专用的整文件解析（不写盘、不构造真实 runtime）。
 *
 * 与全局 `strictSessionJsonl` 的区别只在两处：允许精确形状的 legacy 标题行（保留为 `opaque`），
 * 以及把 v1 的随机 ID 迁移换成确定性 ID。其余严格性不变：树行仍走同一套校验，坏行/断链/孤儿
 * toolResult 继续拒绝。渲染层与宿主可用同一函数，避免三方对“合法会话”的判断不一致。
 */
export function readTransferSession(raw: string): TransferSessionDocument {
  const { header: headerText, body } = splitHeader(raw);
  let header: Record<string, unknown>;
  try {
    const parsed = JSON.parse(headerText) as unknown;
    if (!isObject(parsed)) throw new Error('not object');
    header = parsed;
  } catch {
    throw new Error('SESSION_TRANSFER_BAD_HEADER');
  }
  if (
    header.type !== 'session' ||
    !nonEmpty(header.id) ||
    typeof header.cwd !== 'string' ||
    typeof header.timestamp !== 'string'
  ) {
    throw new Error('SESSION_TRANSFER_BAD_HEADER');
  }
  const version = header.version === undefined ? 1 : header.version;
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new Error(`SESSION_TRANSFER_UNSUPPORTED_VERSION: ${String(version)}`);
  }

  const opaque: string[] = [];
  const opaqueAt: number[] = [];
  const treeRows: Record<string, unknown>[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error('SESSION_TRANSFER_CORRUPT_SESSION: invalid JSON');
    }
    if (!isObject(value)) throw new Error('SESSION_TRANSFER_CORRUPT_SESSION: expected object');
    // v1 全文件没有条目 ID：所有行都参与确定性补 ID（与 SDK v1 迁移一致）。
    if (version === 1 || nonEmpty(value.id)) {
      treeRows.push(value);
      continue;
    }
    if (isLegacyTitleLine(value)) {
      opaque.push(line.replace(/\r$/, ''));
      continue;
    }
    throw new Error('SESSION_TRANSFER_CORRUPT_SESSION: entry is missing an id');
  }

  const normalizedHeader = version === 1 ? { ...header, version: 2 } : header;
  const normalizedRows = version === 1 ? upgradeLegacyEntries(treeRows, raw) : treeRows;
  const canonicalText = `${JSON.stringify(normalizedHeader)}\n${normalizedRows
    .map((row) => JSON.stringify(row))
    .join('\n')}${normalizedRows.length > 0 ? '\n' : ''}`;
  // v2 在这里由 SDK 内存迁移到 v3（只有 hookMessage→custom，ID 不动）；v3 只做严格校验。
  const doc = strictSessionJsonl(canonicalText);
  return {
    header: doc.header,
    entries: doc.entries,
    opaque,
    opaqueAt,
    version,
    synthesizedIds: version === 1,
  };
}

/** 来源快照里出现的所有根（entry 根 + 逐引用根），顺序稳定、去重交给 uniqueRoots。 */
function provenanceRoots(sources: Record<string, TransferSourceRoot>): string[] {
  const roots: string[] = [];
  for (const source of Object.values(sources)) {
    if (nonEmpty(source.root)) roots.push(source.root);
    for (const root of Object.values(source.refs ?? {})) if (nonEmpty(root)) roots.push(root);
  }
  return roots;
}

/**
 * 把规范化后的条目与 opaque 旧行按原位置拼回整文件文本。
 * 头行使用传入的 header（after-image 里会换成目标 cwd）。
 */
function assembleSessionText(
  header: Record<string, unknown>,
  entries: readonly Record<string, unknown>[],
  opaque: readonly string[],
  opaqueAt: readonly number[],
  eol: string,
): string {
  const byIndex = new Map<number, string[]>();
  opaque.forEach((line, position) => {
    const at = opaqueAt[position] ?? entries.length;
    const bucket = byIndex.get(at);
    if (bucket) bucket.push(line);
    else byIndex.set(at, [line]);
  });
  const lines: string[] = [JSON.stringify(header)];
  for (let index = 0; index <= entries.length; index++) {
    for (const line of byIndex.get(index) ?? []) lines.push(line);
    if (index < entries.length) lines.push(JSON.stringify(entries[index]));
  }
  return `${lines.join(eol)}${eol}`;
}

/** 子会话 meta 的托管项目字段改到目标；其余字段（agentId／父路径／mode／结算状态等）原样继承。 */
export function transferredSubagentMeta(
  previous: Record<string, unknown>,
  toWorkspace: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...previous };
  for (const field of MANAGED_SUBAGENT_PROJECT_FIELDS) {
    if (field in next) next[field] = toWorkspace;
  }
  // 规范托管字段：旧 meta 没有 workspace 时补上，供冷恢复判断项目归属；不改其它语义字段。
  next.workspace = toWorkspace;
  return next;
}

function latestSubagentMeta(entries: readonly unknown[]): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  for (const entry of entries) {
    if (!isObject(entry) || entry.type !== 'custom' || entry.customType !== 'subagent_meta') continue;
    if (isObject(entry.data)) found = entry.data;
  }
  return found;
}

function mergeProvenance(
  base: Record<string, TransferSourceRoot>,
  additional: Record<string, TransferSourceRoot>,
): Record<string, TransferSourceRoot> {
  const out: Record<string, TransferSourceRoot> = { ...base };
  for (const [entryId, source] of Object.entries(additional)) {
    const existing = out[entryId];
    if (!existing) {
      out[entryId] = source;
      continue;
    }
    // 已固化的来源优先；只补缺字段，绝不因再次迁移改写旧映射。
    if (existing.refs || source.refs) {
      const refs: Record<string, string> = { ...(source.refs ?? {}) };
      for (const [field, root] of Object.entries(existing.refs ?? {})) refs[field] = root;
      out[entryId] = { root: existing.root, ...(Object.keys(refs).length > 0 ? { refs } : {}) };
    }
  }
  return out;
}

/** 来源比较键：分隔符／尾斜杠／大小写不敏感（与宿主路径等价比法一致）。 */
function rootKey(root: string): string {
  return root.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 提交前检查来源矛盾：同一 entry 的根、或同一 `entryId + field` 引用的根，
 * 在多来源（历史 marker 快照 vs 本次回放、或两个旧 marker）上不一致就拒绝。
 * 正常往返里旧快照与回放应一致；不一致意味着外部改写了日志或快照，不能猜。
 */
function assertNoProvenanceConflict(
  carried: Record<string, TransferSourceRoot>,
  replayed: Record<string, TransferSourceRoot>,
): void {
  for (const [entryId, fresh] of Object.entries(replayed)) {
    const known = carried[entryId];
    if (!known) continue;
    if (rootKey(known.root) !== rootKey(fresh.root)) {
      throw new Error(`TRANSFER_PROVENANCE_CONFLICT: ${entryId} root`);
    }
    for (const [field, root] of Object.entries(fresh.refs ?? {})) {
      const previous = known.refs?.[field];
      if (previous !== undefined && rootKey(previous) !== rootKey(root)) {
        throw new Error(`TRANSFER_PROVENANCE_CONFLICT: ${entryId} ${field}`);
      }
    }
  }
}

/**
 * 生成迁移后的会话原始文本、metadata 与来源快照。
 * 纯函数：不写盘、不创建 runtime、不请求模型；宿主负责 journal、缓存失效与位置恢复。
 */
export function buildTransferredSession(
  raw: string,
  input: BuildTransferredSessionInput,
): TransferredSession {
  if (!nonEmpty(input.operationId)) throw new Error('SESSION_TRANSFER_OPERATION_ID_REQUIRED');
  if (!nonEmpty(input.fromWorkspace) || !nonEmpty(input.toWorkspace)) {
    throw new Error('SESSION_TRANSFER_WORKSPACE_REQUIRED');
  }
  if (input.fromWorkspace.trim() === input.toWorkspace.trim()) {
    throw new Error('SESSION_TRANSFER_SAME_WORKSPACE');
  }
  const beforeSha256 = input.beforeSha256 ?? sha256(raw);
  const document = readTransferSession(raw);
  const header = document.header as unknown as Record<string, unknown>;
  const entries = document.entries as unknown as Record<string, unknown>[];
  const originalIds = new Set(entries.map((entry) => (nonEmpty(entry.id) ? entry.id : '')).filter(Boolean));
  if (input.leafId !== null && !originalIds.has(input.leafId)) {
    throw new Error('SESSION_TRANSFER_UNKNOWN_LEAF');
  }

  const priorTransfers = readSessionProjectTransfers(entries);
  const already = priorTransfers.find((transfer) => transfer.operationId === input.operationId);
  const replayBase = priorTransfers[0]?.fromWorkspace ?? input.fromWorkspace;

  if (already) {
    const provenance: TransferProvenance = {
      version: SESSION_TRANSFER_PROVENANCE_VERSION,
      sources: buildEntryRootProvenance([...entries], replayBase),
    };
    return {
      raw,
      header,
      entries,
      metadata: already,
      provenance,
      appendedEntryIds: [],
      leafId: input.leafId,
      alreadyApplied: true,
      beforeSha256,
    };
  }

  const now = input.now ?? Date.now();
  const timestamp = new Date(now).toISOString();
  const after = entries.map((entry) => entry);
  let parentId = lastEntryIdBefore(after, after.length);
  const appended: Record<string, unknown>[] = [];
  const append = (customType: string, data: unknown): string => {
    const entry: Record<string, unknown> = {
      type: 'custom',
      id: transferEntryId(input.operationId, appended.length),
      parentId,
      timestamp,
      customType,
      data,
    };
    appended.push(entry);
    after.push(entry);
    parentId = entry.id as string;
    return entry.id as string;
  };

  const detectedMeta = input.subagentMeta === undefined ? latestSubagentMeta(entries) : input.subagentMeta ?? undefined;
  const batchSize = 2 + (input.preferences ? 1 : 0) + (detectedMeta ? 1 : 0);
  const boundary = {
    afterEntryId: lastEntryIdBefore(entries, entries.length),
    entryCount: entries.length,
    entryCountAfter: entries.length + batchSize,
  };
  const history = {
    version: SESSION_TRANSFER_PROVENANCE_VERSION,
    ref: input.operationId,
    beforeSha256,
  } as const;

  // 来源快照先基于原始历史算好；本批次新增的 custom 条目本身不承载文件引用，
  // 它们只继承目标根，不需要参与父链重放。
  const carried: Record<string, TransferSourceRoot> = {};
  for (const previous of priorTransfers) {
    if (!previous.provenance) continue;
    // 多个旧 marker 之间已有映射也必须一致；矛盾同样拒绝，而不是取第一个。
    assertNoProvenanceConflict(carried, previous.provenance.sources ?? {});
    Object.assign(carried, mergeProvenance(carried, previous.provenance.sources ?? {}));
  }
  const replayed = buildEntryRootProvenance(entries, replayBase);
  // 矛盾来源拒绝，不静默 first-wins：同一 entry 的根或同一引用的根在不同"once"里不同，
  // 说明日志或快照已被外部改写，提交后无法如实告知用户文件在哪。
  assertNoProvenanceConflict(carried, replayed);
  const sources = mergeProvenance(carried, replayed);
  const provenance: TransferProvenance = { version: SESSION_TRANSFER_PROVENANCE_VERSION, sources };

  const metadataBase: SessionProjectTransferMetadata = {
    version: SESSION_PROJECT_TRANSFER_VERSION,
    operationId: input.operationId,
    fromWorkspace: input.fromWorkspace,
    toWorkspace: input.toWorkspace,
    previousCwd: nonEmpty(header.cwd) ? header.cwd : input.fromWorkspace,
    leafId: input.leafId,
    retentionRoots: uniqueRoots([
      // 旧批次登记的保留根累积保留：源 scratch 里的生成文件可能仍被多代历史引用。
      ...priorTransfers.map((transfer) => transfer.retentionRoots),
      input.retentionRoots,
      [input.fromWorkspace, nonEmpty(header.cwd) ? header.cwd : input.fromWorkspace],
      // 历史里曾 working_directory 到别的目录（另一个 app 的 works/scratch）时，那里生成的文件
      // 仍被历史引用；只登记根，不搬文件，让源 scratch prune 认得这些根。
      provenanceRoots(sources),
    ]),
    boundary,
    history,
    createdAt: now,
  };
  if (input.embedProvenance) metadataBase.provenance = provenance;

  append(SESSION_PROJECT_TRANSFER_ENTRY, metadataBase);
  append('working_directory', { cwd: input.toWorkspace });
  if (input.preferences) append('session-preferences', input.preferences);
  if (detectedMeta) append('subagent_meta', transferredSubagentMeta(detectedMeta, input.toWorkspace));
  // 追加条目固定属于目标根；不覆盖任何已有历史映射。
  for (const entry of appended) sources[entry.id as string] ??= { root: input.toWorkspace };

  const nextHeader: Record<string, unknown> = { ...header, version: 3, cwd: input.toWorkspace };
  const { eol } = splitHeader(raw);
  let output: string;
  if (document.version >= 3) {
    // v3：只替换 header 行；其余历史行逐字节保留（含各分支、签名、legacy 标题与未知字段）。
    // 尾部空白行不属于历史，去掉后保证追加行紧接最后一条真实条目。
    const { body } = splitHeader(raw);
    const kept = body.replace(/[\s\uFEFF]+$/, '');
    // 追加行沿用输入日志的换行风格：CRLF 日志不能混入裸 LF。
    const appendedText = appended.map((entry) => JSON.stringify(entry)).join(eol);
    output = `${JSON.stringify(nextHeader)}${eol}${kept ? `${kept}${eol}` : ''}${appendedText}${eol}`;
  } else {
    // v1／v2：规范化成明确的 v3 after-image。v1 用确定性合成 ID（不依赖 SDK 随机 id）；
    // v2 只做 hookMessage→custom 的 SDK 内存迁移。opaque 标题行保持原位置、原字节。
    output = assembleSessionText(nextHeader, after, document.opaque, document.opaqueAt, eol);
  }

  // 提交前用迁移专用解析器复核：树行仍走同一套严格校验；合法 legacy 标题行按 opaque 保留。
  // 不能用全局 strictSessionJsonl——它会拒绝那条 WorkspaceService 直写的无 ID 标题行。
  readTransferSession(output);

  return {
    raw: output,
    header: nextHeader,
    entries: after,
    metadata: metadataBase,
    provenance,
    appendedEntryIds: appended.map((entry) => entry.id as string),
    leafId: input.leafId,
    alreadyApplied: false,
    beforeSha256,
  };
}

/** metadata 里的边界信息：本批次追加前的最后一条物理条目。 */
export function transferBoundary(metadata: SessionProjectTransferMetadata): { afterEntryId: string | null; entryCount: number } {
  return metadata.boundary;
}

/** 测试/诊断：从已迁移文本里重新读取迁移记录（不写盘）。 */
export function readTransfersFromRaw(raw: string): SessionProjectTransferMetadata[] {
  const doc = strictSessionJsonl(raw);
  return (doc.entries as unknown as unknown[])
    .map((entry) => parseSessionProjectTransfer(entry))
    .filter((entry): entry is SessionProjectTransferMetadata => Boolean(entry));
}
