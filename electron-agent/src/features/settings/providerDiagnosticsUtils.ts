import { defaultLevel, levelDisplayLabel, levelOptions, type RpcModel } from '../chat/input/thinkingLevels';

export interface DiagnosticLevelOption {
  value: string;
  label: string;
}

/** 测活可选的思考档：和输入栏同一套规则（levelOptions）；供应商原生名与中文档名不同时附在后面。 */
export function diagnosticLevelOptions(model: RpcModel | undefined): DiagnosticLevelOption[] {
  return levelOptions(model).map((o) => {
    const value = String(o.value);
    const display = levelDisplayLabel(value);
    const vendor = o.label && o.label !== value && o.label !== display ? o.label : '';
    return { value, label: vendor ? `${display} · ${vendor}` : display };
  });
}

/** 换模型后的档位：当前档仍可选就留着；否则默认关闭（测活最快最省），模型没有关闭档才取它的默认档。 */
export function pickDiagnosticLevel(model: RpcModel | undefined, current: string): string {
  const values = levelOptions(model).map((o) => String(o.value));
  if (values.includes(current)) return current;
  if (values.includes('off')) return 'off';
  return defaultLevel(model);
}

/** 关闭档不带 reasoning，和对话里 off 的发法一致。 */
export function reasoningForLevel(level: string): string | undefined {
  return level === 'off' ? undefined : level;
}

export const DOCK_MIN_HEIGHT = 140;
/** 拖高测活层时给上面留的高度：保存栏 + 测活层标题 + 至少一屏设置。 */
export const SETTINGS_RESERVE = 240;

/** containerHeight 是供应商详情整列的高度；量不到（0）时只管下限。 */
export function clampDockHeight(height: number, containerHeight: number): number {
  const max = containerHeight > 0 ? Math.max(DOCK_MIN_HEIGHT, containerHeight - SETTINGS_RESERVE) : Number.POSITIVE_INFINITY;
  return Math.round(Math.min(Math.max(height, DOCK_MIN_HEIGHT), max));
}

export function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms} ms`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return String(n);
}

export function fmtRate(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `${n.toFixed(1)} tok/s`;
}
