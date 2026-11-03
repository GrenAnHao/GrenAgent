// 会话偏好（模型 / 思考档 / 模式 / 审查档 / Fast）的共享类型与纯解析逻辑。
//
// 约定：
//   - `preferences` 是用户**请求值**；会话 state 顶层 model / thinkingLevel 是 SDK 钳制后的**有效值**。
//     两者分开：换到非推理模型时有效档位会是 off，但请求值仍是用户点的 high，切回来要恢复。
//   - 权威记录是会话日志里的 `session-preferences` 条目（appendCustomEntry）。
//   - 模型 / 思考：一旦 canonical 条目里有该字段，之后的原生 model_change / thinking_level_change
//     只当 legacy fallback —— SDK 的 setModel 与冷恢复都会追加能力钳制后的 effective 值，
//     无条件 last-wins 会把用户请求的 high 抹成 off。下一次显式 patch 写新的 canonical 条目才覆盖。
//   - 模式 / 审查：保持兼容 agent-mode / session-controls 条目的后续覆盖（Plan 确认等
//     这类自动切模式由扩展自己追加条目），不设 canonical 锁。
//   - 缺字段的历史会话逐字段回退，绝不因为一个字段缺失整组重置。
//
// 这个文件必须 browser-safe（只能有类型与纯函数），renderer 直接 re-export 它。
import type { AgentMode } from "../agent-mode/modes.js";
import type { ApprovalPolicy } from "./approval.js";

/** 会话日志里保存四项偏好的条目类型。 */
export const SESSION_PREFERENCES_ENTRY = "session-preferences";

export type SessionPreferenceMode = AgentMode;
export type SessionPreferenceApproval = ApprovalPolicy;

/** 用户请求的五项偏好 + 单调递增修订号。 */
export interface SessionPreferences {
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  mode?: SessionPreferenceMode;
  approval?: SessionPreferenceApproval;
  /** 会话自己的 Fast 开关；旧记录缺省关闭，不读取全局模型偏好。 */
  fastMode?: boolean;
  revision: number;
}

/** 一次修改只带要改的字段；revision 由宿主维护，不接受调用方指定。 */
export interface SessionPreferencesPatch {
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  mode?: SessionPreferenceMode;
  approval?: SessionPreferenceApproval;
  fastMode?: boolean;
}

/** 可被偏好修补的字段名（回执里的 applied / unavailable 用）。 */
export type SessionPreferenceField = keyof SessionPreferencesPatch;
export const SESSION_PREFERENCE_FIELDS: readonly SessionPreferenceField[] = [
  "model",
  "thinkingLevel",
  "mode",
  "approval",
  "fastMode",
];

/**
 * 一次会话偏好写入 / 读取的回执。
 * `applied` 是确实生效的字段；`unavailable` 是请求值保存了、但当前宿主或模型无法生效的字段
 * （例如模型已从目录消失、非推理模型放不下 high）。仅 model 不可用时禁止发送；
 * thinkingLevel 不可原样生效时仍可使用 SDK 钳制后的有效档。
 */
export interface SessionPreferencesAck {
  ok: true;
  sessionId?: string;
  sessionPath?: string;
  sessionFile?: string;
  /** 能力钳制后的有效值；模型元数据保持开放，由具体 UI/宿主校验。 */
  model?: unknown;
  thinkingLevel?: unknown;
  preferences: SessionPreferences;
  applied: SessionPreferenceField[];
  unavailable: SessionPreferenceField[];
  /** 目标会话不在任何 handle 上、只从 jsonl 只读投影时标记。 */
  detached?: true;
}

/** 只有这些 thinking 档位是 SDK 认识的。解析时按全集放行，钳制交给 SDK。 */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MODES = new Set<string>(["agent", "ask", "debug", "plan", "ultra"]);
const APPROVALS = new Set<string>(["readonly", "ask", "auto", "workspace", "full"]);

export function emptySessionPreferences(): SessionPreferences {
  return { revision: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseModel(raw: unknown): { provider: string; id: string } | undefined {
  if (!isRecord(raw)) return undefined;
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  return provider && id ? { provider, id } : undefined;
}

function parseThinkingLevel(raw: unknown): string | undefined {
  return typeof raw === "string" && THINKING_LEVELS.has(raw) ? raw : undefined;
}

function parseMode(raw: unknown): SessionPreferenceMode | undefined {
  return typeof raw === "string" && MODES.has(raw) ? (raw as SessionPreferenceMode) : undefined;
}

function parseApproval(raw: unknown): SessionPreferenceApproval | undefined {
  return typeof raw === "string" && APPROVALS.has(raw) ? (raw as SessionPreferenceApproval) : undefined;
}

/** 逐字段校验；非法字段直接丢弃，不抛错也不整组清零。 */
export function parseSessionPreferencesPatch(raw: unknown): SessionPreferencesPatch {
  if (!isRecord(raw)) return {};
  const patch: SessionPreferencesPatch = {};
  const model = parseModel(raw.model);
  if (model) patch.model = model;
  const thinkingLevel = parseThinkingLevel(raw.thinkingLevel);
  if (thinkingLevel) patch.thinkingLevel = thinkingLevel;
  const mode = parseMode(raw.mode);
  if (mode) patch.mode = mode;
  const approval = parseApproval(raw.approval);
  if (approval) patch.approval = approval;
  if (typeof raw.fastMode === "boolean") patch.fastMode = raw.fastMode;
  return patch;
}

/** 完整快照解析：patch 字段 + revision（缺省 0）。 */
export function parseSessionPreferences(raw: unknown): SessionPreferences {
  const base: SessionPreferences = { revision: 0 };
  if (!isRecord(raw)) return base;
  const next: SessionPreferences = { ...parseSessionPreferencesPatch(raw), revision: 0 };
  // 只在读取旧快照时兼容已移除模式；新写入 patch 仍严格校验。
  if (raw.mode === "brainstorm") next.mode = "agent";
  const revision = raw.revision;
  if (typeof revision === "number" && Number.isInteger(revision) && revision >= 0) next.revision = revision;
  return next;
}

/** 合并 patch 并递增一次 revision。没有实际变化也递增：写盘成功即是一次新版本。 */
export function mergeSessionPreferences(
  base: SessionPreferences,
  patch: SessionPreferencesPatch,
): SessionPreferences {
  return {
    ...base,
    ...(patch.model ? { model: patch.model } : {}),
    ...(patch.thinkingLevel ? { thinkingLevel: patch.thinkingLevel } : {}),
    ...(patch.mode ? { mode: patch.mode } : {}),
    ...(patch.approval ? { approval: patch.approval } : {}),
    ...(typeof patch.fastMode === "boolean" ? { fastMode: patch.fastMode } : {}),
    revision: base.revision + 1,
  };
}

export function sameSessionPreferences(left: SessionPreferences, right: SessionPreferences): boolean {
  return left.revision === right.revision
    && left.thinkingLevel === right.thinkingLevel
    && left.mode === right.mode
    && left.approval === right.approval
    && left.fastMode === right.fastMode
    && left.model?.provider === right.model?.provider
    && left.model?.id === right.model?.id;
}

/**
 * 只读 canonical（`session-preferences`）条目里的请求值，不看原生 model_change / thinking_level_change。
 * 用于冷恢复：原生条目里的值是 SDK 写的 effective 值，可能已经被能力钳制过。
 */
export function readRequestedPreferences(entries: readonly SessionPreferenceEntry[]): SessionPreferences {
  const canonical: SessionPreferences = { revision: 0 };
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type !== "custom" || entry.customType !== SESSION_PREFERENCES_ENTRY) continue;
    const parsed = parseSessionPreferences(entry.data);
    if (parsed.model) canonical.model = parsed.model;
    if (parsed.thinkingLevel) canonical.thinkingLevel = parsed.thinkingLevel;
    if (parsed.mode) canonical.mode = parsed.mode;
    if (parsed.approval) canonical.approval = parsed.approval;
    if (typeof parsed.fastMode === "boolean") canonical.fastMode = parsed.fastMode;
    canonical.revision = Math.max(canonical.revision, parsed.revision);
  }
  return canonical;
}

/** 会话日志条目里本模块关心的最小形状。 */
export interface SessionPreferenceEntry {
  type: string;
  customType?: string;
  provider?: unknown;
  modelId?: unknown;
  thinkingLevel?: unknown;
  data?: unknown;
}

/**
 * 从会话条目（按文件顺序）重建偏好快照。
 *
 * model / thinkingLevel：只有 `session-preferences` 条目里出现过的字段才算 canonical；原生条目只作兜底。
 * 每条 canonical 条目按字段合并（不整份替换），所以只写 mode 的条目不会抹掉已保存的模型。
 * mode / approval：canonical 与 legacy 一起按顺序 last-wins，自动行为（Plan 确认等）照常生效。
 */
export interface ReadSessionPreferencesOptions {
  /**
   * 判断某个原生 thinking 档位是不是“能力钳制的结果”。给定时，canonical 之后出现的原生条目，
   * 只有不等于钳制结果时才算一次显式选择（否则是 setModel 重选档位造成的 artifact）。
   * 不给时保守处理：canonical 之后的原生 thinking 条目一律忽略。
   */
  clampThinking?: (level: string) => string | undefined;
  /**
   * 判断某条原生 thinking 条目是不是宿主自己派生的回显（写 effective 值时产生的）。
   * 返回 true 就当它不存在，避免把派生值误当成用户的新请求。
   */
  suppressNativeThinking?: (level: string) => boolean;
}

export function readSessionPreferences(
  entries: readonly SessionPreferenceEntry[],
  options: ReadSessionPreferencesOptions = {},
): SessionPreferences {
  // canonical 字段按出现顺序逐字段合并；revision 取最大值（两个扩展各自补齐时不会互相倒退）。
  const canonical: SessionPreferences = { revision: 0 };
  // canonical 之后出现的原生条目：模型一律算显式选择（SDK 从不为钳制写 model_change）；
  // thinking 只有在“不像钳制结果”时才算显式，否则会把它误当成新请求。
  let nativeModelAfterCanonical: { provider: string; id: string } | undefined;
  let nativeThinkingAfterCanonical: string | undefined;
  // 原生条目里的最近值：只在 canonical 缺该字段时兜底。
  let nativeModel: { provider: string; id: string } | undefined;
  let nativeThinking: string | undefined;
  // 模式 / 审查：canonical 与 legacy 一起按顺序 last-wins（自动 Plan 行为照常生效）。
  let mode: SessionPreferenceMode | undefined;
  let approval: SessionPreferenceApproval | undefined;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "custom" && entry.customType === SESSION_PREFERENCES_ENTRY) {
      const parsed = parseSessionPreferences(entry.data);
      if (parsed.model) canonical.model = parsed.model;
      if (parsed.thinkingLevel) canonical.thinkingLevel = parsed.thinkingLevel;
      if (parsed.mode) mode = parsed.mode;
      if (parsed.approval) approval = parsed.approval;
      if (typeof parsed.fastMode === "boolean") canonical.fastMode = parsed.fastMode;
      canonical.revision = Math.max(canonical.revision, parsed.revision);
      // 新 canonical 条目之后的历史原生条目不再算“之后的显式选择”。
      nativeModelAfterCanonical = undefined;
      nativeThinkingAfterCanonical = undefined;
      continue;
    }
    if (entry.type === "model_change") {
      const model = parseModel({ provider: entry.provider, id: entry.modelId });
      if (model) {
        nativeModel = model;
        if (canonical.revision > 0) nativeModelAfterCanonical = model;
      }
      continue;
    }
    if (entry.type === "thinking_level_change") {
      const level = parseThinkingLevel(entry.thinkingLevel);
      if (level && !options.suppressNativeThinking?.(level)) {
        nativeThinking = level;
        if (canonical.revision > 0) nativeThinkingAfterCanonical = level;
      }
      continue;
    }
    if (entry.type !== "custom") continue;
    if (entry.customType !== "session-controls" && entry.customType !== "agent-mode") continue;
    if (!isRecord(entry.data)) continue;
    const nextMode = entry.data.mode === "brainstorm" ? "agent" : parseMode(entry.data.mode);
    if (nextMode) mode = nextMode;
    const nextApproval = parseApproval(entry.data.approval);
    if (nextApproval) approval = nextApproval;
  }

  // 模型：原生 model_change 永远是显式选择（SDK 不会为钳制写它），所以 canonical 之后出现就以它为准。
  const model = nativeModelAfterCanonical ?? canonical.model ?? nativeModel;

  // thinking：canonical 之后的原生条目，只有“不是钳制结果”时才算显式选择。
  let explicitThinking: string | undefined;
  if (nativeThinkingAfterCanonical) {
    const clamp = options.clampThinking;
    const base = canonical.thinkingLevel;
    // 没有钳制判定或没有基准值时，无法区分“显式切换”和“SDK 钳制 artifact”，
    // 保守保留请求值（误判成显式会把 requested high 永久丢掉，代价更大）。
    if (clamp && base) {
      const clamped = clamp(base);
      if (clamped === undefined || clamped !== nativeThinkingAfterCanonical) {
        explicitThinking = nativeThinkingAfterCanonical;
      }
    }
  }
  const thinkingLevel = explicitThinking ?? canonical.thinkingLevel ?? nativeThinking;
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(mode ? { mode } : {}),
    ...(approval ? { approval } : {}),
    ...(typeof canonical.fastMode === "boolean" ? { fastMode: canonical.fastMode } : {}),
    revision: canonical.revision,
  };
}
