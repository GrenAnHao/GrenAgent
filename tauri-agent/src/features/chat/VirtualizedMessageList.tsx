import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { VList, type VListHandle } from 'virtua';
import type { DisplayMessage } from './groupMessages';

interface VirtualizedMessageListProps {
  display: DisplayMessage[];
  /** 单条消息渲染器（user/turn/tool/notice 分发）。 */
  renderItem: (msg: DisplayMessage) => ReactNode;
  /** 列表末尾附加元素（如「准备响应中」占位），作为最后一个虚拟条目。 */
  footer?: ReactNode;
  /** 填充方式：主对话父容器是 position:relative → 'absolute'；子代理面板是 flex 子项 → 'flex'（默认）。 */
  fill?: 'absolute' | 'flex';
  /** 每条消息左右内边距（主对话 24，子代理 16）。 */
  paddingInline?: number;
  'data-testid'?: string;
}

// 距底多少像素内算「贴底」：与原手写滚动阈值一致。
const BOTTOM_THRESHOLD = 120;

const fillStyle = (fill: 'absolute' | 'flex'): CSSProperties =>
  fill === 'absolute'
    ? { position: 'absolute', inset: 0 }
    : { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' };

/**
 * 共享虚拟化消息列表：virtua 只渲染视口 ± buffer 的条目（离屏卸载），
 * 并在用户停留在底部时随新内容/流式增长自动滚底（上滑后不打扰）。
 * 主对话与子代理对话共用，替代旧的 LazyMount + 手写 scrollTop/ResizeObserver。
 */
export function VirtualizedMessageList({
  display,
  renderItem,
  footer,
  fill = 'flex',
  paddingInline = 24,
  'data-testid': testId,
}: VirtualizedMessageListProps) {
  const ref = useRef<VListHandle>(null);
  const atBottomRef = useRef(true);

  const itemStyle: CSSProperties = { paddingInline, paddingBlock: 4 };
  const children: ReactNode[] = display.map((msg) => (
    <div key={msg.id} style={itemStyle}>
      {renderItem(msg)}
    </div>
  ));
  if (footer) {
    children.push(
      <div key="__footer" style={itemStyle}>
        {footer}
      </div>,
    );
  }
  const count = children.length;

  // 内容变化（新消息 / 流式增长）后，若用户停留在底部则滚到最后一条。
  useEffect(() => {
    if (atBottomRef.current && ref.current && count > 0) {
      ref.current.scrollToIndex(count - 1, { align: 'end' });
    }
  });

  return (
    <div data-testid={testId} style={fillStyle(fill)}>
      <VList
        ref={ref}
        style={{ height: '100%', flex: 1, minHeight: 0 }}
        onScroll={() => {
          const h = ref.current;
          if (!h) return;
          atBottomRef.current = h.scrollOffset + h.viewportSize >= h.scrollSize - BOTTOM_THRESHOLD;
        }}
      >
        {children}
      </VList>
    </div>
  );
}
