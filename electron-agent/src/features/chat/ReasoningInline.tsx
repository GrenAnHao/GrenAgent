import { memo, useEffect, useRef, useState } from 'react';
import { createStaticStyles, cssVar } from 'antd-style';
import { MutedLine } from './conv/MutedLine';
import { LazyMarkdown } from './LazyMarkdown';
import { cardStyles } from '../tools/cardStyles';

/** 流式推理窗口的最大高度（px）：限高避免长推理把正文挤下去。 */
const REASONING_MAX_HEIGHT = 160;
/** 顶部渐隐：超出限高时用 mask 淡出顶部，替代滚动条（基于内容透明度，不依赖背景色）。 */
const TOP_FADE = 'linear-gradient(to bottom, transparent 0, #000 28px)';

/** 推理耗时文案：<10s 保留一位小数，否则取整。 */
function formatThinkingDuration(ms: number): string {
  if (ms < 10000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.round(ms / 1000)} 秒`;
}

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
    line-height: 1.55;

    *,
    article * {
      color: ${cssVar.colorTextTertiary};
    }
  `,
  header: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
    line-height: 1.55;
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
}

/**
 * 轻量推理段（L1 低调）：
 * - 流式中：限高窗口 + 自动滚到底 + 顶部渐隐，盯着最新一段；
 * - 结束后：收起为 MutedLine 摘要行（点「已深度思考」可展开完整推理）。
 */
function ReasoningInlineInner({ content, streaming, durationMs }: ReasoningInlineProps) {
  const text = content.trim();
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    if (!streaming) return;
    const el = scrollRef.current;
    if (!el) return;
    // 先集中读取、再统一写入。写入 scrollTop 会让布局失效，之后再读 scrollHeight /
    // clientHeight 就会触发强制同步布局（layout thrashing）；流式期间本 effect 每帧都跑，
    // 读写交错会把它放大成持续开销。这里只读一次布局、只写一次，语义与原先等价。
    const { scrollHeight, clientHeight } = el;
    const over = scrollHeight > clientHeight + 1;
    el.scrollTop = scrollHeight;
    setOverflowing((prev) => (prev === over ? prev : over));
  }, [streaming, text]);

  if (!text) return null;

  if (streaming) {
    return (
      <div className={styles.wrap} data-testid="reasoning-inline">
        <div className={styles.header}>
          <span className={cardStyles.breathingDot} />
          <span className={cardStyles.shinyText}>正在深度思考...</span>
        </div>
        <div
          ref={scrollRef}
          className={styles.scroll}
          style={overflowing ? { maskImage: TOP_FADE, WebkitMaskImage: TOP_FADE } : undefined}
        >
          {/*
            流式期间用纯文本增量渲染，不走 Markdown / animated：
            1) Markdown 解析是 O(n)，每个 delta 都重解析整段累积文本 → O(n²)，thinking 越长
               帧率越低，观感就是「几秒不动然后突然全部出现」（结果直出）；
            2) lobehub 的 animated 打字机会从当前位置追向 target，delta 快速涌入时直接跳到
               最新文本，同样看不到逐字增长过程。
            纯文本只更新一个文本节点（O(1)），能稳定逐字增长；流式结束后再走 Markdown
            渲染完整格式（见下方 streaming=false 分支）。
          */}
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} data-testid="reasoning-stream-text">
            {text}
          </div>
        </div>
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
        <LazyMarkdown variant="chat" tone="secondary">
          {text}
        </LazyMarkdown>
      ) : null}
    </div>
  );
}

export const ReasoningInline = memo(ReasoningInlineInner);
