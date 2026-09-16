import { THINKING_LEVEL_ROWS } from '../../settings/modelCompatCatalog';
import { defaultThinkingLevelMap, type ThinkingLevel, type ThinkingLevelMap } from '../../settings/providerConfigAdapter';
import { PROVIDER_PRESETS } from '../../settings/providerPresets';

const LEVEL_DISPLAY = Object.fromEntries(THINKING_LEVEL_ROWS.map((row) => [row.level, row.label])) as Record<string, string>;

/** 对话里展示的档位名（关闭/最低/低…），与设置页「对话档位」同一套。 */
export function levelDisplayLabel(value: string): string {
  return LEVEL_DISPLAY[value] ?? value;
}

const BUILTIN_PROVIDER_IDS = new Set(PROVIDER_PRESETS.map((p) => p.id));

// pi 内部推理档位（off 单独处理）。pi 内部档位只作 RPC 传输，标签显示各家原生取值。
const PI_REASONING_LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// 内置模型未在 get_state 暴露 thinkingLevelMap 时的安全回退：用各家原生名，且只取各家通用支持的档位，
// 避免给出 pi/模型不支持的档位被钳回 off（标签 → pi 传输档位）。
const SAFE_LADDER: Record<string, [string, ThinkingLevel][]> = {
  'anthropic-messages': [['low', 'low'], ['medium', 'medium'], ['high', 'high']],
  'openai-completions': [['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']],
  'openai-responses': [['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']],
  'google-generative-ai': [['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']],
};
const SAFE_LADDER_FALLBACK: [string, ThinkingLevel][] = [['low', 'low'], ['medium', 'medium'], ['high', 'high']];

export interface ThinkingOption {
  label: string;
  value: ThinkingLevel | string;
}

export interface RpcModel {
  id?: string;
  name?: string;
  api?: string;
  provider?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}

function optionsFromMap(map: ThinkingLevelMap, opts: ThinkingOption[]): void {
  for (const pi of PI_REASONING_LEVELS) {
    const v = map[pi];
    // 与设置页一致：只有显式写成字符串的档才出现；null / 缺省键都隐藏（xhigh/max 为 opt-in）。
    if (typeof v !== 'string') continue;
    opts.push({ label: v || pi, value: pi });
  }
}

function hasConfiguredLevels(map: ThinkingLevelMap | undefined): boolean {
  if (!map) return false;
  return Object.values(map).some((v) => typeof v === 'string');
}

/** getState 常丢 thinkingLevelMap：用可用列表里同模型的映射补上，空对象也视为未配置。 */
export function mergeModelCatalog(
  session: RpcModel | null | undefined,
  catalog: readonly RpcModel[],
): RpcModel | null {
  if (!session) return null;
  const info = catalog.find((m) => m.provider === session.provider && m.id === session.id);
  if (!info) return session;
  return {
    ...info,
    ...session,
    api: session.api ?? info.api,
    reasoning: session.reasoning ?? info.reasoning,
    thinkingLevelMap: hasConfiguredLevels(session.thinkingLevelMap)
      ? session.thinkingLevelMap
      : info.thinkingLevelMap,
  };
}

// 选择器档位 = 照搬当前模型的真实档位，标签用供应商原生取值，value 是 pi 内部档位（仅作 RPC 传输）：
//  - 非推理模型：只有 off；
//  - 有 thinkingLevelMap（内置元数据 / 自定义勾「推理」写入）：只展示映射里的字符串档（null / 缺省隐藏）；
//  - 自定义供应商但 get_state 未回传映射：按其 API 协议取完整原生阶梯（与保存进 models.json 的一致）；
//  - 内置供应商且无映射：按协议回退到安全原生档位（避免给出 pi/模型不支持的档位被钳回 off）。
export function levelOptions(model: RpcModel | null | undefined): ThinkingOption[] {
  const opts: ThinkingOption[] = [{ label: 'off', value: 'off' }];
  if (!model || model.reasoning === false) return opts;

  if (hasConfiguredLevels(model.thinkingLevelMap)) {
    optionsFromMap(model.thinkingLevelMap!, opts);
    return opts;
  }

  const isCustom = !!model.provider && !BUILTIN_PROVIDER_IDS.has(model.provider);
  const customMap = isCustom ? defaultThinkingLevelMap(model.api, model.id) : undefined;
  if (customMap) {
    optionsFromMap(customMap, opts);
    return opts;
  }

  const ladder = (model.api && SAFE_LADDER[model.api]) || SAFE_LADDER_FALLBACK;
  for (const [label, value] of ladder) opts.push({ label, value });
  return opts;
}

/** 模型默认推理档位：非推理模型→off；推理模型→中等(medium)，缺失则取最低可选推理档。 */
export function defaultLevel(model: RpcModel | null | undefined): string {
  if (!model || model.reasoning === false) return 'off';
  const opts = levelOptions(model);
  if (opts.some((o) => o.value === 'medium')) return 'medium';
  const firstReasoning = opts.find((o) => o.value !== 'off');
  return (firstReasoning?.value as string | undefined) ?? 'off';
}

/** 切到某模型时该用的档位：优先用记忆（且对该模型有效），否则用模型默认（不沿用上一个模型）。 */
export function resolveLevelForModel(
  model: RpcModel | null | undefined,
  remembered: string | undefined,
): string {
  if (remembered && levelOptions(model).some((o) => o.value === remembered)) return remembered;
  return defaultLevel(model);
}
