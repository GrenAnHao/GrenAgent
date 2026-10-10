import { memo, useEffect, useRef, useState } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import { MutedLine } from './conv/MutedLine';
import { Disclosure } from './conv/Disclosure';
import { LazyMarkdown } from './LazyMarkdown';
import { cardStyles } from '../tools/cardStyles';

/** 展开后的推理窗口最大高度（px）。流式和完成态共用，默认收起。 */
const REASONING_MAX_HEIGHT = 160;
/** 顶部渐隐：超出限高时用 mask 淡出顶部，替代滚动条（基于内容透明度，不依赖背景色）。 */
const TOP_FADE = 'linear-gradient(to bottom, transparent 0, #000 28px)';
/** 单行摘要左右淡出，避免贴边裁字。 */
const SUMMARY_MASK =
  'linear-gradient(to right, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%)';

/** 单行摘要追赶速度。恒定像素/秒，新字匀速从右侧进入，不跳到行尾。 */
const SUMMARY_SCROLL_PX_PER_SEC = 720;

/** 推理耗时只显示整秒。一位小数会把 1 秒定时器的相位差显示成 1.1、2.1。 */
export function formatThinkingDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} 秒`;
}

/**
 * 把已显示的横向偏移匀速推向目标。落后时仍是恒定速度，单帧最多走 48ms，
 * 避免后台标签恢复时一次跳完。
 */
export function nextLinearOffset(current: number, target: number, dtMs: number): number {
  if (target <= current) return target;
  const step = (SUMMARY_SCROLL_PX_PER_SEC * Math.max(0, Math.min(dtMs, 48))) / 1000;
  return Math.min(target, current + step);
}

/** 收起态只展示最后一行非空思考，旧行不进单行视口。 */
export function latestThinkingLine(content: string): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i]?.trim() ?? '';
    if (text) return text;
  }
  return '';
}

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    width: 100%;
    min-width: 0;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
    line-height: 1.55;

    article * {
      color: ${cssVar.colorTextTertiary};
    }
  `,
  streamRow: css`
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: none;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
    line-height: 1.55;
    text-align: start;
    cursor: pointer;
  `,
  label: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  `,
  summary: css`
    min-width: 0;
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    color: ${cssVar.colorTextQuaternary};
  `,
  summaryText: css`
    display: inline-block;
    white-space: nowrap;
    will-change: transform;
  `,
  scroll: css`
    max-height: ${REASONING_MAX_HEIGHT}px;
    overflow-y: auto;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  `,
}));

interface ReasoningInlineProps {
  content: string;
  streaming: boolean;
  durationMs?: number;
  /** 流式计时起点。缺省时从本组件开始流式的时刻算。 */
  startedAt?: number;
}

/** 流式中按整秒推进。对齐起点的整秒边界，避免定时器相位把 1 秒显示成 1.1 秒。 */
function useLiveElapsed(startedAt: number | undefined, streaming: boolean): number | undefined {
  const fallbackStart = useRef<number | null>(null);
  if (streaming && fallbackStart.current == null) fallbackStart.current = Date.now();
  if (!streaming) fallbackStart.current = null;
  const origin = streaming ? (startedAt ?? fallbackStart.current ?? undefined) : undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (origin == null) return;
    let timer = 0;
    const arm = () => {
      setNow(Date.now());
      const into = (Date.now() - origin) % 1000;
      const wait = into === 0 ? 1000 : 1000 - into;
      timer = window.setTimeout(arm, wait);
    };
    arm();
    return () => window.clearTimeout(timer);
  }, [origin]);

  if (origin == null) return undefined;
  return Math.max(0, now - origin);
}

/**
 * 轻量推理段：
 * - 流式默认收起。一行「正在深度思考 · 整秒 > 最后一行」，新字匀速从右侧进入。
 * - 结束后单行消失，只留「已深度思考」。点开才看全文。
 */
function ReasoningInlineInner({ content, streaming, durationMs, startedAt }: ReasoningInlineProps) {
  const text = content.trim();
  const line = latestThinkingLine(text);
  const [expanded, setExpanded] = useState(false);
  const summaryRef = useRef<HTMLSpanElement>(null);
  const summaryTextRef = useRef<HTMLSpanElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [summaryOverflowing, setSummaryOverflowing] = useState(false);
  const [bodyOverflowing, setBodyOverflowing] = useState(false);
  const elapsed = useLiveElapsed(startedAt, streaming);
  const wasStreaming = useRef(streaming);
  const shownOffsetRef = useRef(0);
  const prevLineRef = useRef('');

  useEffect(() => {
    if (wasStreaming.current && !streaming) setExpanded(false);
    wasStreaming.current = streaming;
  }, [streaming]);

  useEffect(() => {
    const viewport = summaryRef.current;
    const textEl = summaryTextRef.current;
    if (!viewport || !textEl || !streaming || expanded || !line) return;
    const replaced = prevLineRef.current.length > 0 && !line.startsWith(prevLineRef.current);
    prevLineRef.current = line;
    let snap = replaced;
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const target = Math.max(0, textEl.scrollWidth - viewport.clientWidth);
      if (snap) {
        shownOffsetRef.current = target;
        snap = false;
      } else {
        shownOffsetRef.current = nextLinearOffset(shownOffsetRef.current, target, now - last);
      }
      last = now;
      textEl.style.transform = `translate3d(${-shownOffsetRef.current}px,0,0)`;
      const over = target > 1;
      setSummaryOverflowing((prev) => (prev === over ? prev : over));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [streaming, expanded, line]);

  useEffect(() => {
    if (!streaming || !expanded) return;
    const el = scrollRef.current;
    if (!el) return;
    const { scrollHeight, clientHeight } = el;
    const over = scrollHeight > clientHeight + 1;
    el.scrollTop = scrollHeight;
    setBodyOverflowing((prev) => (prev === over ? prev : over));
  }, [streaming, expanded, text]);

  if (!text) return null;

  if (streaming) {
    const time =
      elapsed != null && elapsed >= 500 ? ` · ${formatThinkingDuration(elapsed)}` : '';
    return (
      <div className={styles.wrap} data-testid="reasoning-inline">
        <button
          type="button"
          className={styles.streamRow}
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          <span className={styles.label}>
            <span className={cardStyles.breathingDot} />
            <span className={cardStyles.shinyText}>正在深度思考{time}</span>
          </span>
          <Disclosure open={expanded} />
          {expanded || !line ? null : (
            <span
              ref={summaryRef}
              className={styles.summary}
              data-testid="reasoning-stream-text"
              style={
                summaryOverflowing
                  ? { maskImage: SUMMARY_MASK, WebkitMaskImage: SUMMARY_MASK }
                  : undefined
              }
            >
              <span ref={summaryTextRef} className={styles.summaryText}>
                {line}
              </span>
            </span>
          )}
        </button>
        {expanded ? (
          <div
            ref={scrollRef}
            className={styles.scroll}
            data-testid="reasoning-stream-body"
            style={bodyOverflowing ? { maskImage: TOP_FADE, WebkitMaskImage: TOP_FADE } : undefined}
          >
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
          </div>
        ) : null}
      </div>
    );
  }

  const label =
    durationMs != null && durationMs > 0
      ? `已深度思考 · ${formatThinkingDuration(durationMs)}`
      : '已深度思考';

  return (
    <div className={styles.wrap} data-testid="reasoning-inline">
      <MutedLine text={label} open={expanded} onToggle={() => setExpanded((v) => !v)} />
      {expanded ? (
        <div className={styles.scroll} data-testid="reasoning-body">
          <LazyMarkdown variant="chat" tone="secondary">
            {text}
          </LazyMarkdown>
        </div>
      ) : null}
    </div>
  );
}

export const ReasoningInline = memo(ReasoningInlineInner);
