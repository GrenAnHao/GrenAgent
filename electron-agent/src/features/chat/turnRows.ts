import type { TimelineSegment, ToolSegment, ThinkingSegment } from './groupMessages';
import { isContextTool, skillNameFromRead } from '../tools/toolUtils';

export type TurnRow =
  | { kind: 'segment'; id: string; segment: TimelineSegment }
  | { kind: 'context'; id: string; tools: ToolSegment[] };

/**
 * 把连续多段 reasoning 合并为一段：模型在「逐条调用 todo / 反复调用同一工具」时，往往每次调用前都
 * 吐一小段简短 reasoning（如「继续添加剩余任务」）。todo 卡片按 turn 去重成一张后，这些 reasoning 段
 * 在时间线里彼此相邻，原样渲染就堆成一排「已深度思考 · 0.0 秒」刷屏。这里把相邻段拼接成一段、耗时
 * 累加，折叠成单条「已深度思考」（展开仍可看全程）。id 取首段以保持 React key 稳定。
 */
function mergeThinking(parts: ThinkingSegment[]): ThinkingSegment {
  return {
    kind: 'thinking',
    id: parts[0]!.id,
    content: parts
      .map((p) => p.content)
      .filter((c) => c.trim())
      .join('\n\n'),
    // 任一段仍在流式则整体按流式渲染（通常是最后一段当前正在思考）。
    streaming: parts.some((p) => p.streaming),
    // 累加各段耗时；全为 0/缺省时回退 undefined，让 ReasoningInline 只显示「已深度思考」不带秒数。
    durationMs: parts.reduce((sum, p) => sum + (p.durationMs ?? 0), 0) || undefined,
  };
}

/**
 * 把一轮的扁平时间线段落折叠成渲染行：
 * - 连续 2 个及以上的「查找类」工具（read/grep/glob/list）合并成一条 context 折叠行；
 * - 连续 2 段及以上的 reasoning 合并成一条「已深度思考」（见 mergeThinking，治 todo 刷屏）；
 * - 其余（正文、动作工具、落单的查找工具 / 思考）按原顺序逐行展开。
 * 折叠行始终停留在它在时间线里的真实位置。
 *
 * 例外：模型用 read 读取 SKILL.md 是「调用技能」，语义上不是普通上下文收集——把它从折叠里
 * 排除，单独渲染成技能调用卡（见 ToolExecution 的 skill 分支）。
 */
export function buildTurnRows(segments: TimelineSegment[]): TurnRow[] {
  const rows: TurnRow[] = [];
  let ctxBuffer: ToolSegment[] = [];
  let thinkBuffer: ThinkingSegment[] = [];

  const flushCtx = () => {
    if (ctxBuffer.length === 0) return;
    if (ctxBuffer.length >= 2) {
      rows.push({ kind: 'context', id: `ctx-${ctxBuffer[0]!.id}`, tools: ctxBuffer });
    } else {
      rows.push({ kind: 'segment', id: ctxBuffer[0]!.id, segment: ctxBuffer[0]! });
    }
    ctxBuffer = [];
  };

  const flushThink = () => {
    if (thinkBuffer.length === 0) return;
    const seg = thinkBuffer.length >= 2 ? mergeThinking(thinkBuffer) : thinkBuffer[0]!;
    rows.push({ kind: 'segment', id: seg.id, segment: seg });
    thinkBuffer = [];
  };

  for (const segment of segments) {
    if (segment.kind === 'thinking') {
      flushCtx();
      thinkBuffer.push(segment);
      continue;
    }
    if (
      segment.kind === 'tool' &&
      isContextTool(segment.toolName) &&
      !skillNameFromRead(segment.toolName, segment.args)
    ) {
      flushThink();
      ctxBuffer.push(segment);
      continue;
    }
    flushThink();
    flushCtx();
    rows.push({ kind: 'segment', id: segment.id, segment });
  }
  flushThink();
  flushCtx();
  return rows;
}
