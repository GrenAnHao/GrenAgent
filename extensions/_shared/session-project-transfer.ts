// 会话跨项目迁移的共享、无副作用事实层（宿主与渲染层共用，browser-safe）。
//
// 一次移动写成一条版本化 custom entry `session_project_transfer`，后面紧跟目标 `working_directory`。
// 物理日志路径、会话 ID 和全部历史行不变；这里只回答“这段历史属于哪个项目根”：
//   - 每个 entry 的根沿自己的完整父链求值（父链上的 working_directory / 持久 toolResult details），
//     旁支互不继承，避免 A 分支最后一次 cd 被 B 分支的引用误用。
//   - 迁移 marker 出现前的一切属于源项目；marker 之后才属于目标项目。
//   - 旧 `working_directory` 记录（marker 之前）永远不能把恢复后的 cwd 拉回源目录。
//   - 多次迁移按文件顺序形成目录段；已有逐引用来源先出现先用，绝不因后续迁移改写。
//
// 历史来源快照的权威副本在宿主 journal；本模块的纯函数可从日志条目确定性重放，供冷恢复与重载使用。
// 无迁移记录的旧会话完全走原路径（调用方先 `isTransferredSession` 再取根）。

export const SESSION_PROJECT_TRANSFER_ENTRY = "session_project_transfer";
export const SESSION_PROJECT_TRANSFER_VERSION = 1;
/** 历史逐引用来源快照的版本；快照本体在 journal，marker 只记版本与引用。 */
export const SESSION_TRANSFER_PROVENANCE_VERSION = 1;

export interface SessionProjectTransferBoundary {
  /** 迁移批次之前最后一条树条目的 id；null 表示空会话根（无树条目）。 */
  afterEntryId: string | null;
  /**
   * 迁移批次之前已有树条目数（含此前追加的迁移记录）。
   * 不含合法但无树身份的 legacy 标题行（`{"type":"session_info","name":…}`），那些不是条目。
   */
  entryCount: number;
  /** 本批次（迁移记录 + 目标 cwd + 可选偏好/子代理 meta）追加后的树条目数。 */
  entryCountAfter?: number;
}

export interface SessionProjectTransferHistoryRef {
  version: typeof SESSION_TRANSFER_PROVENANCE_VERSION;
  /** journal 里的来源快照引用（operationId）；不指向任何项目目录。 */
  ref: string;
  /** 迁移前整份日志的 sha256（宿主提供时）。 */
  beforeSha256?: string;
}

export interface SessionProjectTransferMetadata {
  version: typeof SESSION_PROJECT_TRANSFER_VERSION;
  operationId: string;
  fromWorkspace: string;
  toWorkspace: string;
  /** 迁移前会话头 cwd（源项目根）。 */
  previousCwd: string;
  /** 迁移前用户确认的 leaf；null 表示空根。新增 custom entry 不得冒充它。 */
  leafId: string | null;
  /**
   * 源 scratch 保留根：这些目录里的历史生成文件仍被迁移历史引用期间，自动 orphan prune 不得删除。
   * 累积此前各次迁移的根；至少包含本次原 fromWorkspace（以及当时的 header cwd）。
   */
  retentionRoots?: string[];
  boundary: SessionProjectTransferBoundary;
  history: SessionProjectTransferHistoryRef;
  /** 该次迁移固定下来的历史来源快照（可选；journal 里有完整副本）。 */
  provenance?: TransferProvenance;
  createdAt: number;
  [field: string]: unknown;
}

export interface TransferSourceRoot {
  root: string;
  /** 逐引用来源：`path`、`files.0.path`、`paths.1` 等字段路径 → 该引用发生时的目录根。 */
  refs?: Record<string, string>;
}

export interface TransferProvenance {
  version: typeof SESSION_TRANSFER_PROVENANCE_VERSION;
  sources: Record<string, TransferSourceRoot>;
}

export interface TransferNotice {
  fromWorkspace: string;
  toWorkspace: string;
  operationId: string;
}

type Entry = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function readPath(value: unknown): string | undefined {
  if (!nonEmpty(value)) return undefined;
  return value;
}

/** 只接受本版本、形状完整的迁移记录；未知版本一律忽略，不做推测解释。 */
export function parseSessionProjectTransfer(entry: unknown): SessionProjectTransferMetadata | undefined {
  if (!isObject(entry) || entry.type !== "custom" || entry.customType !== SESSION_PROJECT_TRANSFER_ENTRY) {
    return undefined;
  }
  const data = entry.data;
  if (!isObject(data) || data.version !== SESSION_PROJECT_TRANSFER_VERSION) return undefined;
  const operationId = readPath(data.operationId);
  const fromWorkspace = readPath(data.fromWorkspace);
  const toWorkspace = readPath(data.toWorkspace);
  const previousCwd = readPath(data.previousCwd) ?? fromWorkspace;
  const leafId = data.leafId === null ? null : readPath(data.leafId);
  if (!operationId || !fromWorkspace || !toWorkspace || !previousCwd) return undefined;
  if (data.leafId !== null && leafId === undefined) return undefined;
  const boundary = isObject(data.boundary) ? data.boundary : {};
  const history = isObject(data.history) ? data.history : {};
  const boundaryEntryId = boundary.afterEntryId === null ? null : readPath(boundary.afterEntryId);
  if (!Number.isFinite(boundary.entryCount)) return undefined;
  return {
    ...(data as SessionProjectTransferMetadata),
    version: SESSION_PROJECT_TRANSFER_VERSION,
    operationId,
    fromWorkspace,
    toWorkspace,
    previousCwd,
    leafId: leafId ?? null,
    boundary: {
      afterEntryId: boundaryEntryId ?? null,
      entryCount: boundary.entryCount as number,
      ...(Number.isFinite(boundary.entryCountAfter) ? { entryCountAfter: boundary.entryCountAfter as number } : {}),
    },
    history: {
      version: SESSION_TRANSFER_PROVENANCE_VERSION,
      ref: readPath(history.ref) ?? operationId,
      ...(nonEmpty(history.beforeSha256) ? { beforeSha256: history.beforeSha256 } : {}),
    },
    createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
  };
}

interface TransferHit {
  index: number;
  metadata: SessionProjectTransferMetadata;
}

function transferHits(entries: readonly unknown[]): TransferHit[] {
  const hits: TransferHit[] = [];
  if (!Array.isArray(entries)) return hits;
  for (let i = 0; i < entries.length; i++) {
    const metadata = parseSessionProjectTransfer(entries[i]);
    if (metadata) hits.push({ index: i, metadata });
  }
  return hits;
}

/** 按文件顺序的全部合法迁移记录（最旧在前）。 */
export function readSessionProjectTransfers(entries: readonly unknown[]): SessionProjectTransferMetadata[] {
  return transferHits(entries).map((hit) => hit.metadata);
}

export function latestSessionProjectTransfer(entries: readonly unknown[]): SessionProjectTransferMetadata | undefined {
  const hits = transferHits(entries);
  return hits.length > 0 ? hits[hits.length - 1]!.metadata : undefined;
}

export function isTransferredSession(entries: readonly unknown[]): boolean {
  return latestSessionProjectTransfer(entries) !== undefined;
}

/** 下一次显式请求要注入的当前迁移事实；无迁移或记录不完整时 undefined。 */
export function readLatestTransferNotice(entries: readonly unknown[]): TransferNotice | undefined {
  const latest = latestSessionProjectTransfer(entries);
  if (!latest) return undefined;
  return { fromWorkspace: latest.fromWorkspace, toWorkspace: latest.toWorkspace, operationId: latest.operationId };
}

/**
 * 当前有效项目根：有迁移记录时取最后一次迁移的目标；否则就是会话头 cwd。
 * 不读取任何 `working_directory`——项目身份不等同于工具 cwd。
 */
export function effectiveProjectRoot(entries: readonly unknown[], headerCwd: string): string {
  return latestSessionProjectTransfer(entries)?.toWorkspace ?? headerCwd;
}

/**
 * 重新打开会话时应恢复的工具 cwd。
 *
 * 有迁移记录时：只看最后一次迁移记录之后写入的 `working_directory`；没有就落到该次目标根。
 * 迁移记录之前的旧记录（源项目当时的 cwd）一律不参与，避免旧工作目录把会话拉回源项目。
 */
export function effectiveRecordedCwd(entries: readonly unknown[], headerCwd: string, leafId?: string | null): string {
  const hits = transferHits(entries);
  if (hits.length === 0) return headerCwd;
  const marker = hits[hits.length - 1]!;
  if (leafId !== undefined) {
    const byId = new Map(entries.slice(marker.index + 1).filter(isObject).filter(entry => nonEmpty(entry.id)).map(entry => [entry.id as string, entry]));
    let current = leafId;
    const visited = new Set<string>();
    while (current && byId.has(current) && !visited.has(current)) {
      visited.add(current);
      const entry = byId.get(current)!;
      if (entry.type === "custom" && entry.customType === "working_directory" && isObject(entry.data) && nonEmpty(entry.data.cwd)) return entry.data.cwd;
      current = nonEmpty(entry.parentId) ? entry.parentId : null;
    }
    return marker.metadata.toWorkspace;
  }
  for (let i = entries.length - 1; i > marker.index; i--) {
    const entry = entries[i];
    if (!isObject(entry) || entry.type !== "custom" || entry.customType !== "working_directory") continue;
    const data = isObject(entry.data) ? entry.data : {};
    if (nonEmpty(data.cwd)) return data.cwd;
  }
  return marker.metadata.toWorkspace;
}

/**
 * 迁移追加行之后是否已经开始了新的活动（新回合、压缩、标签、用量等）。
 * 迁移自身只追加这几类 custom entry；除此之外的条目都说明用户/扩展已经在迁移后写过新东西。
 */
const TRANSFER_APPENDED_CUSTOM_TYPES = new Set([
  SESSION_PROJECT_TRANSFER_ENTRY,
  "working_directory",
  "session-preferences",
  "subagent_meta",
]);

/**
 * 冷恢复（子会话）应恢复的确认 leaf。
 *
 * 迁移在历史尾部追加了 metadata／cwd／meta，物理 leaf 因此变成了追加行；但用户确认的位置仍是迁移前那条。
 * 只有在**迁移之后尚未开始新活动**时才回到 metadata.leafId（null 表示空根）：
 *   - 之后出现了任何非迁移追加条目（新消息、usage、label、分支汇总等）→ 不回退，沿用物理 leaf；
 *   - 同一会话多次迁移时，只看最后一次迁移之后。
 * 返回 undefined 表示不是迁移会话（调用方保持原行为）。
 */
export function transferredLeafToRestore(
  entries: readonly unknown[],
): { leafId: string | null; restore: boolean } | undefined {
  const hits = transferHits(entries);
  if (hits.length === 0) return undefined;
  const last = hits[hits.length - 1]!;
  for (let i = last.index + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (!isObject(entry)) continue;
    if (entry.type === "custom" && nonEmpty(entry.customType) && TRANSFER_APPENDED_CUSTOM_TYPES.has(entry.customType)) {
      continue;
    }
    return { leafId: last.metadata.leafId, restore: false };
  }
  return { leafId: last.metadata.leafId, restore: true };
}

/** 最后一次迁移记录在条目数组里的位置；无迁移时 -1。 */
export function lastTransferEntryIndex(entries: readonly unknown[]): number {
  const hits = transferHits(entries);
  return hits.length > 0 ? hits[hits.length - 1]!.index : -1;
}

/** 迁移记录之前的最后一条物理条目 id（构建新 metadata 的边界）。 */
export function lastEntryIdBefore(entries: readonly unknown[], index: number): string | null {
  for (let i = Math.min(index, entries.length) - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isObject(entry) && nonEmpty(entry.id)) return entry.id;
  }
  return null;
}

interface ToolCallRef {
  entryId: string;
  args: Record<string, unknown>;
}

function toolCallsOf(entries: readonly unknown[]): Map<string, ToolCallRef> {
  const calls = new Map<string, ToolCallRef>();
  for (const entry of entries) {
    if (!isObject(entry) || entry.type !== "message" || !isObject(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "assistant" || !Array.isArray(message.content) || !nonEmpty(entry.id)) continue;
    for (const block of message.content) {
      if (!isObject(block) || block.type !== "toolCall" || !nonEmpty(block.id) || !isObject(block.arguments)) continue;
      calls.set(block.id, { entryId: entry.id, args: block.arguments });
    }
  }
  return calls;
}

/** 从工具参数/details 里抽出可能按相对路径解析的引用字段。 */
function referencePaths(value: Record<string, unknown>, prefix: string, out: Array<{ field: string; path: string }>): void {
  const path = readPath(value.path);
  if (path) out.push({ field: prefix ? `${prefix}.path` : "path", path });
  if (typeof value.file === "string" && value.file.trim()) {
    out.push({ field: prefix ? `${prefix}.file` : "file", path: value.file });
  }
  if (Array.isArray(value.paths)) {
    value.paths.forEach((item, index) => {
      if (typeof item === "string" && item.trim()) {
        out.push({ field: `${prefix ? `${prefix}.` : ""}paths.${index}`, path: item });
      }
    });
  }
  if (Array.isArray(value.files)) {
    value.files.forEach((item, index) => {
      const base = `${prefix ? `${prefix}.` : ""}files.${index}`;
      if (typeof item === "string" && item.trim()) out.push({ field: base, path: item });
      else if (isObject(item)) {
        const itemPath = readPath(item.path);
        if (itemPath) out.push({ field: `${base}.path`, path: itemPath });
      }
    });
  }
}

/**
 * 按完整父链与持久目录事实，为每个历史 entry 及其工具引用解析迁移前的来源根。
 *
 * - 顺序扫描全部条目（不只当前分支）；每个条目只依赖自己的父链状态，因此旁支互不污染。
 * - 迁移 marker 把根切到该次目标；`working_directory` 与成功的持久 toolResult 改变后续根。
 * - 引用键是 `entryId + toolCallId + 字段`（字段即 refs 的 key），值是该引用发生时所在目录。
 *
 * 返回 `entryId → { root, refs }`。无迁移记录时调用方不应使用（仍可用来诊断）。
 */
export function buildEntryRootProvenance(
  entries: readonly unknown[],
  baseWorkspace: string,
): Record<string, TransferSourceRoot> {
  const sources: Record<string, TransferSourceRoot> = {};
  const calls = toolCallsOf(entries);
  const roots = new Map<string, string>();
  const indices = new Map<string, number>();
  let segmentRoot = baseWorkspace;
  let segmentStart = 0;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!isObject(entry) || !nonEmpty(entry.id)) continue;
    const entryId = entry.id;
    const transfer = parseSessionProjectTransfer(entry);
    if (transfer) {
      segmentRoot = transfer.toWorkspace;
      segmentStart = index;
    }
    // A transfer is appended to the physical log, not necessarily to the confirmed branch.
    // Parents before its boundary cannot restore an old working directory for new entries.
    const parent = nonEmpty(entry.parentId) ? entry.parentId : undefined;
    let root = transfer ? segmentRoot
      : parent && (indices.get(parent) ?? -1) >= segmentStart
        ? roots.get(parent) ?? segmentRoot : segmentRoot;
    if (!transfer && entry.type === "custom" && entry.customType === "working_directory") {
      const data = isObject(entry.data) ? entry.data : {};
      if (nonEmpty(data.cwd)) root = data.cwd;
    } else if (!transfer && entry.type === "message" && isObject(entry.message) && entry.message.role === "toolResult") {
      const message = entry.message;
      const details = isObject(message.details) ? message.details : undefined;
      const toolName = typeof message.toolName === "string" ? message.toolName : "";
      if (details && message.isError !== true) {
        if (toolName === "working_directory" && nonEmpty(details.cwd) && details.changed !== false) root = details.cwd;
        else if (toolName === "create_worktree" && nonEmpty(details.path)) root = details.path;
      }
    }

    roots.set(entryId, root);
    indices.set(entryId, index);
    const refs = referenceRootsFor(entry, root, calls, roots);
    const existing = transfer?.provenance?.sources;
    if (existing) for (const [id, source] of Object.entries(existing)) sources[id] ??= source;
    sources[entryId] ??= { root, ...(refs ? { refs } : {}) };
  }
  return sources;
}

function referenceRootsFor(
  entry: Record<string, unknown>,
  entryRoot: string,
  calls: Map<string, ToolCallRef>,
  roots: Map<string, string>,
): Record<string, string> | undefined {
  if (entry.type !== "message" || !isObject(entry.message) || entry.message.role !== "toolResult") return undefined;
  const callId = entry.message.toolCallId;
  if (!nonEmpty(callId)) return undefined;
  const call = calls.get(callId);
  const callRoot = call ? roots.get(call.entryId) ?? entryRoot : entryRoot;
  const found: Array<{ field: string; path: string }> = [];
  if (call) referencePaths(call.args, "", found);
  const details = isObject(entry.message.details) ? entry.message.details : undefined;
  if (details) referencePaths(details, "", found);
  if (found.length === 0) return undefined;
  const refs: Record<string, string> = {};
  // 同一字段先出现者优先（工具参数是下发布局，结果 details 是其回显）。
  for (const item of found) if (!(item.field in refs)) refs[item.field] = callRoot;
  return Object.keys(refs).length > 0 ? refs : undefined;
}

/** 单条 entry 的来源根；没有快照时返回 undefined。 */
export function entrySourceRoot(sources: Record<string, TransferSourceRoot>, entryId: string | null | undefined): string | undefined {
  if (!entryId) return undefined;
  return sources[entryId]?.root;
}

/** 单个引用的来源根：先看该字段的逐引用快照，再退回 entry 根。 */
export function referenceSourceRoot(
  sources: Record<string, TransferSourceRoot>,
  entryId: string | null | undefined,
  field?: string,
): string | undefined {
  if (!entryId) return undefined;
  const source = sources[entryId];
  if (!source) return undefined;
  if (field && source.refs && source.refs[field]) return source.refs[field];
  return source.root;
}

export function referenceKey(toolCallId: string, field: string): string {
  return `${toolCallId}\u0000${field}`;
}

/**
 * 历史投影用：仅在会话确有迁移记录时重放逐 entry 来源；旧会话不付代价、行为不变。
 */
export function historyTransferSources(
  entries: readonly unknown[],
  headerCwd: string,
): Record<string, TransferSourceRoot> | undefined {
  const first = transferHits(entries)[0];
  if (!first) return undefined;
  return buildEntryRootProvenance(entries, first.metadata.fromWorkspace ?? headerCwd);
}
