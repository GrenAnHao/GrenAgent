import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { VList, type VListHandle } from 'virtua';
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ArrowDown } from 'lucide-react';
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
  /**
   * 会话 / 对话标识：变化（含首次挂载）时重置滚动锚点并强制贴底。
   * 主对话在会话间复用同一列表实例，切换会话时若不重置，旧的 atBottom/锚点会导致
   * 「首次打开不贴底」「切换时用旧锚点回跳而抖动」。传入当前会话 path 即可修复。
   */
  resetKey?: string | null;
  'data-testid'?: string;
}

// 距底多少像素内算「贴底」：与原手写滚动阈值一致。
const BOTTOM_THRESHOLD = 120;
// 离屏缓冲条数（virtua 默认 4）：调大以减少快速滚动时的空白——离屏多预渲染几条、提前挂载与测高。
// 取 18 折中：够挡住常速快速滚动的露白，又不至于让过多重型 Markdown 常驻挂载拖累基线性能。
const BUFFER_SIZE = 18;
// 未测量项的高度预估（hint）：减少离屏项进入视口实测时的滚动跳动。消息高度并不均匀，故仅作初始估算、
// 测量后即被真实高度取代（virtua 文档建议 uniform 时使用，这里取一个中位量级、副作用可控）。
const ITEM_SIZE_HINT = 100;
// 「回到底部」按钮显示所需最少条数（对齐旧手写列表：太短的列表不必显示）。
const JUMP_MIN_ITEMS = 3;

const styles = createStaticStyles(({ css }) => ({
  jump: css`
    position: absolute;
    inset-block-end: 16px;
    inset-inline-end: 16px;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 50%;
    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};
    color: ${cssVar.colorText};
    cursor: pointer;
    transition: background 0.15s ease;

    &:hover {
      background: ${cssVar.colorFillSecondary};
    }
  `,
}));

const fillStyle = (fill: 'absolute' | 'flex'): CSSProperties =>
  fill === 'absolute'
    ? { position: 'absolute', inset: 0 }
    : { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' };

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
  resetKey,
  'data-testid': testId,
}: VirtualizedMessageListProps) {
  const ref = useRef<VListHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const countRef = useRef(0);
  const resizingRef = useRef(false);
  // 不贴底时 resize 的稳定锚点：顶部可见条目索引 + 该条目已滚过视口顶的像素。
  const anchorIndexRef = useRef(0);
  const anchorWithinRef = useRef(0);
  const [showJump, setShowJump] = useState(false);

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
  countRef.current = count;

  // 贴底：仅在用户停留在底部时滚到最后一条（用 ref 读最新 count，供 resize 回调复用）。
  const stickToBottom = () => {
    if (atBottomRef.current && ref.current && countRef.current > 0) {
      ref.current.scrollToIndex(countRef.current - 1, { align: 'end' });
    }
  };

  // 一键回到底部：平滑滚到末条并恢复自动贴底（对齐旧手写列表的「回到底部」按钮）。
  const jumpToBottom = () => {
    if (!ref.current || countRef.current === 0) return;
    atBottomRef.current = true;
    setShowJump(false);
    ref.current.scrollToIndex(countRef.current - 1, { align: 'end', smooth: true });
  };

  // 内容变化（新消息 / 流式增长）后贴底。用 layout effect：绘制前同步贴底，消除「先显旧位置再跳底」的一帧闪
  //（旧手写列表用的就是 useLayoutEffect，迁移到 virtua 时曾降级为 useEffect，这里改回）。
  useLayoutEffect(stickToBottom);

  // 会话切换（resetKey 变）或首次挂载：重置滚动锚点为「贴底」，并在 virtua 完成首轮高度测量后精确滚到底。
  // 为什么要双 rAF：virtua 初次以 itemSize 估算高度，此刻 scrollToIndex 落点不准（表现为首次打开不贴底）；
  // 且切换会话若沿用旧的 atBottom/锚点，virtua 逐帧测高重排会把视图往旧位置拽（表现为抖动）。
  // 先立即滚一次（估算位），再在随后两帧测高稳定后各滚一次，落到真实底部、不抖。
  useLayoutEffect(() => {
    atBottomRef.current = true;
    anchorIndexRef.current = 0;
    anchorWithinRef.current = 0;
    setShowJump(false);
    const toBottom = () => {
      const h = ref.current;
      if (h && countRef.current > 0) h.scrollToIndex(countRef.current - 1, { align: 'end' });
    };
    toBottom();
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      toBottom();
      r2 = requestAnimationFrame(toBottom);
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
    // 仅在会话标识变化时重置贴底；同会话内的增量贴底由上面的 useLayoutEffect(stickToBottom) 负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // 视口尺寸变化（窗口压缩 / 面板折叠 / 文字重排）时保持位置。
  // 难点：virtua 在 resize 时按自身锚点逐帧重排，中部阅读位会抖；且重排触发的 onScroll 会污染贴底判断。
  // 方案：resize 期间用 resizingRef 冻结 atBottomRef/锚点（onScroll 跳过），按冻结前意图持续钉回——
  //   贴底：交给收尾一次性 scrollToIndex(end)（virtua 自身贴底重排是平滑的，逐帧滚反而打架）；
  //   不贴底：逐帧 scrollTo(锚点条目当前 offset + 偏移)，盖掉 virtua 的抖动，把阅读位钉死。
  //   收尾再钉一次确保最终位置准确，并延一帧解冻以避开程序化滚动自身触发的 onScroll。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const restore = () => {
      const h = ref.current;
      if (!h) return;
      if (atBottomRef.current) {
        if (countRef.current > 0) h.scrollToIndex(countRef.current - 1, { align: 'end' });
      } else {
        // 用 scrollToIndex 而非 scrollTo：它保证锚点条目落入渲染范围，rapid resize 下即使条目高度暂时
        // 还是旧值也不会因 offset 越界而瞬间空白；align:'start'+offset 落点与原 scrollTo 等价。
        h.scrollToIndex(anchorIndexRef.current, { align: 'start', offset: anchorWithinRef.current });
      }
    };
    const ro = new ResizeObserver(() => {
      resizingRef.current = true;
      if (!atBottomRef.current) restore();
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        restore();
        requestAnimationFrame(() => {
          resizingRef.current = false;
        });
      }, 100);
    });
    ro.observe(el);
    return () => {
      clearTimeout(settleTimer);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={fillStyle(fill)}>
      <div
        ref={containerRef}
        data-testid={testId}
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, height: '100%' }}
        onWheel={(e) => {
          // 用户主动上滚：立刻脱离自动贴底，避免流式输出（每 100ms 重渲染都触发 stickToBottom）
          // 把视图反复拽回底部、打断阅读。滚回贴近底部后 onScroll 会重新判定 atBottom 恢复自动贴底。
          if (e.deltaY < 0) atBottomRef.current = false;
        }}
      >
        <VList
          ref={ref}
          style={{ height: '100%', flex: 1, minHeight: 0 }}
          bufferSize={BUFFER_SIZE}
          itemSize={ITEM_SIZE_HINT}
          onScroll={() => {
            if (resizingRef.current) return;
            const h = ref.current;
            if (!h) return;
            const atBottom = h.scrollOffset + h.viewportSize >= h.scrollSize - BOTTOM_THRESHOLD;
            atBottomRef.current = atBottom;
            // 离底且列表够长时露出「回到底部」按钮；贴底时隐藏。
            setShowJump(!atBottom && countRef.current > JUMP_MIN_ITEMS);
            // 记录当前顶部可见条目作为锚点，供 resize 期间钉回阅读位置。
            anchorIndexRef.current = h.findItemIndex(h.scrollOffset);
            anchorWithinRef.current = h.scrollOffset - h.getItemOffset(anchorIndexRef.current);
          }}
        >
          {children}
        </VList>
      </div>
      {showJump ? (
        <button
          type="button"
          className={styles.jump}
          onClick={jumpToBottom}
          title="回到底部"
          aria-label="回到底部"
        >
          <Icon icon={ArrowDown} size={16} />
        </button>
      ) : null}
    </div>
  );
}
