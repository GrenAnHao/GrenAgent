// GPT with Taste 的作用域判定：gpt-with-taste 扩展与 fable-behavior 共用同一套判据。
//
// 两层都是「行为系统提示」，同时注入会互相覆盖语气和纪律。约定：taste 对 GPT 系模型生效时，
// fable 这一轮不再注入；切回非 GPT 模型时 fable 自动恢复。判据放这里而不是任一侧，是为了
// 让两侧永远算出同一个答案（fable 不能既认为 taste 生效又照样注入）。
//
// 会话内 `/taste off` 把状态写在会话分支上，fable 也读同一份状态，所以关掉 taste 会立刻把
// fable 放回来。配置项 `GPT_WITH_TASTE=0` 是整机级别的关闭。
import { getConfig as readConfig } from "./runtime-config.js";

export const TASTE_STATE_TYPE = "gpt-with-taste:state";
export const DEFAULT_TASTE_MODEL_PATTERN = "^gpt-";

export interface TasteState {
  enabled?: boolean;
  steering?: boolean;
}

export interface TasteModel {
  provider?: string;
  id?: string;
}

export interface TasteEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

type GetConfig = (key: string) => string | undefined;

/** 整机开关：只有显式 `GPT_WITH_TASTE=0` 才关闭（默认开）。 */
export function tasteConfigEnabled(getConfig: GetConfig = readConfig): boolean {
  return (getConfig("GPT_WITH_TASTE") ?? "1") !== "0";
}

/** 生效范围：默认按模型 id 前缀 `gpt-`，可用 `GPT_WITH_TASTE_MODEL_PATTERN` 覆盖。 */
export function tasteScopeRegex(getConfig: GetConfig = readConfig): RegExp {
  const raw = getConfig("GPT_WITH_TASTE_MODEL_PATTERN")?.trim() || DEFAULT_TASTE_MODEL_PATTERN;
  try {
    return new RegExp(raw, "i");
  } catch {
    return new RegExp(DEFAULT_TASTE_MODEL_PATTERN, "i");
  }
}

export function tasteScopeMatches(model: TasteModel | undefined, pattern: RegExp): boolean {
  return Boolean(model?.id) && pattern.test(String(model?.id));
}

/** 从会话分支取最近一条 `/taste` 状态；没有条目时返回空对象（= 默认开、steer 开）。 */
export function readTasteState(entries: readonly TasteEntry[] | undefined): TasteState {
  if (!entries) return {};
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== TASTE_STATE_TYPE) continue;
    const data = entry.data;
    return data && typeof data === "object" ? (data as TasteState) : {};
  }
  return {};
}

/** 会话分支上的条目；读不到时按空算（等价于默认状态）。宿主上下文形状不可信，一律吞掉异常。 */
export function branchEntriesOf(ctx: unknown): readonly TasteEntry[] {
  try {
    const entries = (ctx as { sessionManager?: { getBranch?: () => unknown } })?.sessionManager?.getBranch?.();
    return Array.isArray(entries) ? (entries as readonly TasteEntry[]) : [];
  } catch {
    return [];
  }
}

export interface TasteProbe {
  model?: TasteModel;
  entries?: readonly TasteEntry[];
  getConfig?: GetConfig;
}

/** taste 是否接管这一轮的模型。fable-behavior 用它决定要不要让位。 */
export function tasteApplies({ model, entries, getConfig = readConfig }: TasteProbe): boolean {
  if (!tasteConfigEnabled(getConfig)) return false;
  if (!tasteScopeMatches(model, tasteScopeRegex(getConfig))) return false;
  return readTasteState(entries).enabled !== false;
}

/** steer 提醒是否跟随；`/taste steer off` 只关提醒，不撤整段文本。 */
export function tasteSteeringOn({ entries, getConfig = readConfig }: TasteProbe): boolean {
  if (!tasteConfigEnabled(getConfig)) return false;
  return readTasteState(entries).steering !== false;
}
