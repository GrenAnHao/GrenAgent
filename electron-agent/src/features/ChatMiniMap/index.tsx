import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DisplayMessage } from '../chat/groupMessages';
import type { MessageListViewport } from '../chat/VirtualizedMessageList';
import { MinimapIndicator } from './MinimapIndicator';
import { MinimapPreview } from './MinimapPreview';
import { minimapStyles } from './styles';
import { useMinimapData } from './useMinimapData';
import {
  getEmphasis,
  getFractionalPosition,
  getRailScrollTop,
  MIN_MESSAGES_THRESHOLD,
} from './utils';

/** 移出 rail 后延迟关闭：在相邻刻度之间掠过时气泡不会闪。 */
const CLOSE_DELAY_MS = 120;

interface ChatMiniMapProps {
  /** 与虚拟列表同一份 display 消息，保证刻度的下标能直接用于跳转。 */
  messages: DisplayMessage[];
  viewport: MessageListViewport;
}

interface HoverState {
  position: number;
  /** 悬停刻度的中线相对容器顶部的偏移，气泡以此对齐。 */
  anchorY: number;
}

/**
 * 对话迷你地图：贴在消息列表左缘的竖排刻度，一条用户消息一条横线，默认统一长度。
 * 悬停某条时它和邻近几条按距离逐级伸长形成鼓包，右侧弹出这一轮的问答摘要；点击跳到对应消息。
 * 对话很长时 rail 限高可滚，并随正文滚动同步滑动，让当前刻度始终居中。
 */
export const ChatMiniMap = memo<ChatMiniMapProps>(({ messages, viewport }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const popupPositionedRef = useRef(false);
  const hoveringRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const { indicators, activePosition, handleJump } = useMinimapData(messages, viewport);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  // rail 跟随：把视口位置（顶部条目 + 两条用户消息间的像素进度）换算成刻度上的小数位置，滚到 rail 中线。
  // 正文每滚一帧 rail 就同步动一点，而不是等活跃刻度顶到边缘才跳一格。
  // 悬停期间暂停——否则流式输出把正文拽到底时 rail 会从鼠标下面溜走，气泡跟着乱切。
  const followViewport = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const rail = railRef.current;
      if (!rail || hoveringRef.current) return;
      const fractional = getFractionalPosition(
        indicators,
        viewport.getTopIndex(),
        viewport.getScrollOffset(),
        viewport.getItemOffset,
      );
      const top = getRailScrollTop(fractional, rail.clientHeight, rail.scrollHeight);
      if (behavior === 'smooth' && typeof rail.scrollTo === 'function') {
        rail.scrollTo({ top, behavior });
      } else {
        rail.scrollTop = top;
      }
    },
    [indicators, viewport],
  );

  useEffect(() => {
    followViewport();
    return viewport.subscribe(followViewport);
  }, [followViewport, viewport]);

  const handleHover = useCallback(
    (position: number, element: HTMLElement) => {
      clearCloseTimer();
      const container = containerRef.current;
      if (!container) return;
      const rect = element.getBoundingClientRect();
      const anchorY = rect.top + rect.height / 2 - container.getBoundingClientRect().top;
      setHover({ position, anchorY });
    },
    [clearCloseTimer],
  );

  const handleRailEnter = () => {
    clearCloseTimer();
    hoveringRef.current = true;
  };

  const handleRailLeave = () => {
    hoveringRef.current = false;
    // 用户可能用滚轮把 rail 拨到了别处，离开后平滑滑回当前位置。
    followViewport('smooth');
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setHover(null);
      closeTimerRef.current = null;
    }, CLOSE_DELAY_MS);
  };

  // 气泡以悬停刻度为中线，再夹在容器上下边界内：贴近顶部或底部的刻度不会把气泡顶出可视区。
  // 高度要等气泡渲染后才量得到，所以在 layout effect 里直接写样式，绘制前就落到位。
  // 首次出现时临时关掉 top 过渡，避免从 0 滑入；之后在刻度间移动才让它滑。
  useLayoutEffect(() => {
    const popup = popupRef.current;
    const container = containerRef.current;
    if (!hover || !popup || !container) {
      popupPositionedRef.current = false;
      return;
    }
    const height = popup.offsetHeight;
    const maxTop = Math.max(0, container.clientHeight - height);
    const top = Math.min(Math.max(0, hover.anchorY - height / 2), maxTop);
    const first = !popupPositionedRef.current;
    if (first) popup.style.transition = 'none';
    popup.style.top = `${top}px`;
    if (first) {
      void popup.offsetHeight;
      popup.style.transition = '';
      popupPositionedRef.current = true;
    }
  }, [hover]);

  if (indicators.length <= MIN_MESSAGES_THRESHOLD) return null;

  const hoveredPosition = hover?.position ?? null;
  const hoveredIndicator = hoveredPosition === null ? undefined : indicators[hoveredPosition];

  return (
    <div ref={containerRef} className={minimapStyles.container} data-testid="chat-minimap">
      <div
        ref={railRef}
        className={minimapStyles.rail}
        role="group"
        onMouseEnter={handleRailEnter}
        onMouseLeave={handleRailLeave}
      >
        {indicators.map(({ id, listIndex }, position) => (
          <MinimapIndicator
            emphasis={getEmphasis(position, hoveredPosition)}
            id={id}
            isActive={activePosition === position}
            key={id}
            listIndex={listIndex}
            onHover={handleHover}
            onJump={handleJump}
            position={position}
          />
        ))}
      </div>
      {hoveredIndicator ? (
        <div ref={popupRef} className={minimapStyles.popup} role="tooltip">
          <MinimapPreview indicator={hoveredIndicator} />
        </div>
      ) : null}
    </div>
  );
});

ChatMiniMap.displayName = 'ChatMiniMap';
