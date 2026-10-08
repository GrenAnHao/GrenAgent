import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';
import { VList, type VListHandle } from 'virtua';
import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ArrowDown } from 'lucide-react';
import { CHAT_CONTENT_WIDTH } from './chatStyles';
import type { DisplayMessage } from './groupMessages';
import { scrollbarGutterPx } from './composerWheel';

export interface TranscriptScrollHandle {
  scrollBy: (deltaY: number) => void;
}

/**
 * 叠加层用的视口把手：让浮层（如 ChatMiniMap）能跳转、并跟随视口位置。
 * 位置走「订阅」而非 state：滚动时只有浮层自己响应，
 * 不会带着整列重型 Markdown 消息一起重渲染。
 */
export interface MessageListViewport {
  /** 平滑滚动到指定条目，使其对齐视口顶部。 */
  scrollToIndex: (index: number) => void;
  /** 视口顶部条目的下标。 */
  getTopIndex: () => number;
  /** 当前滚动偏移（px）。与 getItemOffset 配合，浮层可按像素比例平滑跟随而不是逐条跳。 */
  getScrollOffset: () => number;
  /** 指定条目的起始偏移（px）；尚未测量的条目为估算值。 */
  getItemOffset: (index: number) => number;
  /** 订阅视口位置变化（滚动的每一帧），返回取消订阅函数。 */
  subscribe: (listener: () => void) => () => void;
}

interface VirtualizedMessageListProps {
  display: DisplayMessage[];
  /** 单条消息渲染器（user/turn/tool/notice 分发）。 */
  renderItem: (msg: DisplayMessage) => ReactNode;
  /** 列表末尾附加元素（如「准备响应中」占位），作为最后一个虚拟条目。 */
  footer?: ReactNode;
  /** 覆盖在列表之上的浮层（如 ChatMiniMap），拿到视口把手以跳转与高亮。 */
  overlay?: (viewport: MessageListViewport) => ReactNode;
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
  /** 列表末尾座椅留白（px）：作为尾行高度，而不是滚动容器 CSS padding-bottom。 */
  paddingBottom?: number;
  onGutterChange?: (px: number) => void;
  scrollRef?: Ref<TranscriptScrollHandle>;
  'data-testid'?: string;
}

// 距底多少像素内算「贴底」：与原手写滚动阈值一致。
const BOTTOM_THRESHOLD = 120;
// 离屏缓冲：virtua 用 bufferSize 取代旧的 overscan 后，单位从「条数」改成了「像素」，默认 200。
// 快速滚动时浏览器先合成滚动、React 才补渲染新区间，缓冲不足就会先露白再补上；聊天条目高，
// 一帧位移常有数百像素，200px 挡不住。取 800（约一屏）覆盖数帧的快速滚动。
// 缓冲只在滚动方向生效（静止时两侧才都加），代价约是多挂载一两条消息。
const BUFFER_SIZE = 800;
// 「回到底部」按钮显示所需最少条数（对齐旧手写列表：太短的列表不必显示）。
const JUMP_MIN_ITEMS = 3;
// footer 槽位：作为 data 的最后一项参与测高与贴底，避免为它单独维护一套下标换算。
const FOOTER_ROW = '__footer';
type Row = DisplayMessage | typeof FOOTER_ROW;

const styles = createStaticStyles(({ css }) => ({
  jump: css`
    position: absolute;
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
  overlay,
  fill = 'flex',
  paddingInline = 24,
  resetKey,
  paddingBottom = 0,
  onGutterChange,
  scrollRef,
  'data-testid': testId,
}: VirtualizedMessageListProps) {
  const ref = useRef<VListHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // 打开会话后的测高窗口：virtua 先按估算高度滚，onScroll 会误判「不在底部」并取消贴底。
  // 这段时间内忽略该误判，持续滚到真实底部，直到高度稳住或用户主动上滚。
  const pinningRef = useRef(false);
  const countRef = useRef(0);
  const resizingRef = useRef(false);
  // 不贴底时 resize 的稳定锚点：顶部可见条目索引 + 该条目已滚过视口顶的像素。
  const anchorIndexRef = useRef(0);
  const anchorWithinRef = useRef(0);
  // 浮层的视口订阅者：每次滚动（anchor 更新后）通知一次，读数直接走 handle 与 anchor ref。
  const viewportListenersRef = useRef(new Set<() => void>());
  const [showJump, setShowJump] = useState(false);

  // 视口把手对象保持恒等，避免浮层因 props 变化反复重建订阅。
  const viewport = useMemo<MessageListViewport>(
    () => ({
      scrollToIndex: (index) => ref.current?.scrollToIndex(index, { align: 'start', smooth: true }),
      getTopIndex: () => anchorIndexRef.current,
      getScrollOffset: () => ref.current?.scrollOffset ?? 0,
      getItemOffset: (index) => ref.current?.getItemOffset(index) ?? 0,
      subscribe: (listener) => {
        viewportListenersRef.current.add(listener);
        return () => {
          viewportListenersRef.current.delete(listener);
        };
      },
    }),
    [],
  );

  const notifyViewport = () => {
    for (const listener of viewportListenersRef.current) listener();
  };

  // 内容列限宽并水平居中：paddingInline 留在限宽之内（box-sizing 全局 border-box），
  // 于是窄容器退回 100% 时它继续充当左右留白，宽容器下则与输入区的内边距一起对齐同一条列边。
  // 浮层（ChatMiniMap / 回到底部）挂在最外层 wrapper 上，仍贴滚动区两侧边缘，不随内容列收窄。
  const itemStyle: CSSProperties = {
    width: CHAT_CONTENT_WIDTH,
    marginInline: 'auto',
    paddingInline,
    paddingBlock: 4,
  };
  // 只把数据交给 virtua，元素由渲染函数按需创建：children 数组形态下，每次重渲染都要为全部消息
  // 创建元素、再被 virtua 整体摊平一遍，而流式期间列表每 100ms 就重渲一次，长会话下这笔开销很可观。
  const hasFooter = Boolean(footer) || paddingBottom > 0;
  const rows = useMemo<Row[]>(
    () => (hasFooter ? [...display, FOOTER_ROW] : display),
    [display, hasFooter],
  );
  countRef.current = rows.length;

  // 贴底直接写滚动容器的 scrollTop，不走 virtua 的 scrollToIndex：后者会挂一个「条目测高后 150ms 内
  // 重滚到目标」的任务，用户滚动不会取消它。流式中刚往上滚一下，新挂上的条目一测高就把视图拽回底部。
  // 末尾条目测高后变高由下面的内容 ResizeObserver 跟上。
  const scrollToEnd = () => {
    const el = containerRef.current?.firstElementChild;
    if (el instanceof HTMLElement && countRef.current > 0) el.scrollTop = el.scrollHeight;
  };

  // 贴底：仅在用户停留在底部时滚到最后一条（用 ref 读最新 count，供 resize 回调复用）。
  const stickToBottom = () => {
    if (atBottomRef.current) scrollToEnd();
  };

  // 一键回到底部：平滑滚到最后一条。
  const jumpToBottom = () => {
    if (!ref.current || countRef.current === 0) return;
    atBottomRef.current = true;
    setShowJump(false);
    ref.current.scrollToIndex(countRef.current - 1, { align: 'end', smooth: true });
  };

  // 内容变化（新消息 / 流式增长）后贴底。用 layout effect：绘制前同步贴底，消除「先显旧位置再跳底」的一帧闪
  //（旧手写列表用的就是 useLayoutEffect，迁移到 virtua 时曾降级为 useEffect，这里改回）。
  useLayoutEffect(stickToBottom);

  // 会话切换（resetKey 变）或首次挂载：钉在底部，直到 virtua 把末尾条目测高并稳住。
  // 两帧 rAF 不够：估算高度下滚到的「底部」在测高后会变，随后 onScroll 把 atBottom 清掉，
  // 真实高度长出来后就不再贴底。测高期间忽略这次误判，高度连续稳定后再放开。
  useLayoutEffect(() => {
    atBottomRef.current = true;
    pinningRef.current = true;
    anchorIndexRef.current = 0;
    anchorWithinRef.current = 0;
    notifyViewport();
    setShowJump(false);

    // 用帧数而不是墙上时间：测试环境里 rAF 可能同步空转，performance.now 不前进会死循环。
    const maxFrames = 24;
    let frames = 0;
    let lastSize = -1;
    let stableFrames = 0;
    let raf = 0;
    const tick = () => {
      if (!pinningRef.current || frames >= maxFrames) {
        pinningRef.current = false;
        return;
      }
      frames += 1;
      const h = ref.current;
      if (!h || countRef.current === 0) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const atBottom = h.scrollOffset + h.viewportSize >= h.scrollSize - BOTTOM_THRESHOLD;
      if (!atBottom) scrollToEnd();
      const size = h.scrollSize;
      if (atBottom && size === lastSize) {
        stableFrames += 1;
        if (stableFrames >= 3) {
          pinningRef.current = false;
          return;
        }
      } else {
        stableFrames = 0;
        lastSize = size;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      pinningRef.current = false;
      cancelAnimationFrame(raf);
    };
    // 仅在会话标识变化时重置贴底；同会话内的增量贴底由上面的 useLayoutEffect(stickToBottom) 负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useImperativeHandle(scrollRef, () => ({
    scrollBy(deltaY) {
      if (deltaY < 0) {
        atBottomRef.current = false;
        pinningRef.current = false;
      }
      ref.current?.scrollBy(deltaY);
    },
  }));

  useLayoutEffect(() => {
    const el = containerRef.current?.firstElementChild;
    if (!(el instanceof HTMLElement)) return;
    const report = () => {
      onGutterChange?.(scrollbarGutterPx(el.offsetWidth, el.clientWidth));
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onGutterChange]);

  // 内容总高变化（末尾条目测高、流式正文长高、懒加载内容撑开）时，贴底状态下跟到新的底部。
  // 视口自身的尺寸变化交给下面的 resize 逻辑，那段时间不在这里插手。
  useEffect(() => {
    const content = containerRef.current?.firstElementChild?.firstElementChild;
    if (!(content instanceof HTMLElement)) return;
    const ro = new ResizeObserver(() => {
      if (!resizingRef.current) stickToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 视口尺寸变化（窗口压缩 / 面板折叠 / 文字重排）时保持位置。
  // 难点：virtua 在 resize 时按自身锚点逐帧重排，中部阅读位会抖；且重排触发的 onScroll 会污染贴底判断。
  // 方案：resize 期间用 resizingRef 冻结 atBottomRef/锚点（onScroll 跳过），按冻结前意图持续钉回——
  //   贴底：交给收尾一次性 scrollToEnd（virtua 自身贴底重排是平滑的，逐帧滚反而打架）；
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
        scrollToEnd();
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
          if (e.deltaY < 0) {
            atBottomRef.current = false;
            pinningRef.current = false;
          }
        }}
      >
        <VList
          ref={ref}
          data={rows}
          style={{ height: '100%', flex: 1, minHeight: 0 }}
          bufferSize={BUFFER_SIZE}
          onScroll={() => {
            if (resizingRef.current || pinningRef.current) return;
            const h = ref.current;
            if (!h) return;
            const atBottom = h.scrollOffset + h.viewportSize >= h.scrollSize - BOTTOM_THRESHOLD;
            atBottomRef.current = atBottom;
            // 离底且列表够长时露出「回到底部」按钮；贴底时隐藏。
            setShowJump(!atBottom && countRef.current > JUMP_MIN_ITEMS);
            // 记录当前顶部可见条目作为锚点，供 resize 期间钉回阅读位置。
            anchorIndexRef.current = h.findItemIndex(h.scrollOffset);
            anchorWithinRef.current = h.scrollOffset - h.getItemOffset(anchorIndexRef.current);
            notifyViewport();
          }}
        >
          {(row: Row) =>
            row === FOOTER_ROW ? (
              <div key={FOOTER_ROW}>
                {footer ? <div style={itemStyle}>{footer}</div> : null}
                {paddingBottom > 0 ? (
                  <div data-testid="seat-spacer" style={{ height: paddingBottom }} />
                ) : null}
              </div>
            ) : (
              <div key={row.id} style={itemStyle}>
                {renderItem(row)}
              </div>
            )
          }
        </VList>
      </div>
      {overlay?.(viewport)}
      {showJump ? (
        <button
          type="button"
          className={styles.jump}
          data-testid="jump-to-bottom"
          style={{ insetBlockEnd: paddingBottom + 16 }}
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
