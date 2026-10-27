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
import { scrollbarGutterPx } from './composerWheel';
import { TranscriptFollow } from './transcriptFollow';

export interface TranscriptScrollHandle {
  scrollBy: (deltaY: number) => void;
  /** 把某条消息滚进渲染范围（查找跳到还没渲染的消息）。会打断贴底跟随。 */
  scrollToItem?: (id: string) => void;
  /** 列表容器元素（查找在它里面找每条消息的 `data-find-item`）。 */
  getRoot?: () => HTMLElement | null;
  /** 列表的滚动容器。 */
  getScroller?: () => HTMLElement | null;
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

interface VirtualizedMessageListProps<T extends { id: string }> {
  display: T[];
  /** 单条消息渲染器（user/turn/tool/notice 分发）。 */
  renderItem: (msg: T) => ReactNode;
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
   * 主对话在会话间复用同一列表实例，切换会话时若不重置，旧的跟随状态/锚点会导致
   * 「首次打开不贴底」「切换时用旧锚点回跳而抖动」。传入当前会话 path 即可修复。
   */
  resetKey?: string | null;
  /** 用户自己刚发出的消息 id（末尾是用户消息时才有）：变成新值时恢复贴底，与读者当前位置无关。 */
  followKey?: string | null;
  /** 列表末尾座椅留白（px）：作为尾行高度，而不是滚动容器 CSS padding-bottom。 */
  paddingBottom?: number;
  onGutterChange?: (px: number) => void;
  scrollRef?: Ref<TranscriptScrollHandle>;
  'data-testid'?: string;
}

// 钉底循环用：virtua 估算高度下离底多少像素内算「已经到底」，到底且总高连续稳定才放手。
const PIN_THRESHOLD = 120;
// 钉底最多跑多少帧。用帧数而不是墙上时间：测试环境里 rAF 可能同步空转，performance.now 不前进会死循环。
const PIN_MAX_FRAMES = 24;
// 离屏缓冲：virtua 用 bufferSize 取代旧的 overscan 后，单位从「条数」改成了「像素」，默认 200。
// 快速滚动时浏览器先合成滚动、React 才补渲染新区间，缓冲不足就会先露白再补上；聊天条目高，
// 一帧位移常有数百像素，200px 挡不住。取 800（约一屏）覆盖数帧的快速滚动。
// 缓冲只在滚动方向生效（静止时两侧才都加），代价约是多挂载一两条消息。
const BUFFER_SIZE = 800;
// footer 槽位：作为 data 的最后一项参与测高与贴底，避免为它单独维护一套下标换算。
const FOOTER_ROW = '__footer';
type Row<T> = T | typeof FOOTER_ROW;
// 读者手势：打断钉底，并告诉 TranscriptFollow 接下来的上移是读者造成的。
const READING_INTENTS = ['wheel', 'touchstart', 'keydown'] as const;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

const styles = createStaticStyles(({ css }) => ({
  // virtua 滚动期间给条目容器写 inline pointer-events: none，停下再撤掉。pointer-events 会继承，
  // 每切一次，已挂载的全部消息（代码高亮的 span 动辄上千个）都要重算样式，单次 40~60ms；
  // 拖分隔条、流式贴底带来的程序化滚动会反复触发它。钉住计算值，切换就只落在容器自己身上。
  scroller: css`
    > div {
      pointer-events: auto !important;
    }
  `,
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
 * 跟随意图归 TranscriptFollow；这里只负责 DOM 事件、virtua 测高期间的钉底和 resize 锚点。
 */
export function VirtualizedMessageList<T extends { id: string }>({
  display,
  renderItem,
  footer,
  overlay,
  fill = 'flex',
  paddingInline = 24,
  resetKey,
  followKey,
  paddingBottom = 0,
  onGutterChange,
  scrollRef,
  'data-testid': testId,
}: VirtualizedMessageListProps<T>) {
  const ref = useRef<VListHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [follow] = useState(() => new TranscriptFollow(setFollowing));
  // 钉底窗口：virtua 先按估算高度滚，测高后底部会变。这段时间持续贴到真实底部，
  // 期间的滚动回声只记账，直到高度稳住或读者出手。
  const pinningRef = useRef(false);
  const pinRafRef = useRef(0);
  const countRef = useRef(0);
  const resizingRef = useRef(false);
  // 不跟随时 resize 的稳定锚点：顶部可见条目索引 + 该条目已滚过视口顶的像素。
  const anchorIndexRef = useRef(0);
  const anchorWithinRef = useRef(0);
  // 浮层的视口订阅者：每次滚动（anchor 更新后）通知一次，读数直接走 handle 与 anchor ref。
  const viewportListenersRef = useRef(new Set<() => void>());

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
  const rows = useMemo<Row<T>[]>(
    () => (hasFooter ? [...display, FOOTER_ROW] : display),
    [display, hasFooter],
  );
  countRef.current = rows.length;

  // 贴底直接写滚动容器的 scrollTop，不走 virtua 的 scrollToIndex：后者会挂一个「条目测高后 150ms 内
  // 重滚到目标」的任务，用户滚动不会取消它。流式中刚往上滚一下，新挂上的条目一测高就把视图拽回底部。
  // 末尾条目测高后变高由下面的内容 ResizeObserver 跟上。
  const getScroller = () => {
    const el = containerRef.current?.firstElementChild;
    return el instanceof HTMLElement && countRef.current > 0 ? el : null;
  };

  // 内容或尺寸变了：跟随中就跟到新的底部（读者移动待采样时不动）。
  const reconcile = () => {
    const el = getScroller();
    if (el) follow.reconcile(el);
  };

  const stopPinning = () => {
    pinningRef.current = false;
    cancelAnimationFrame(pinRafRef.current);
  };

  // 贴到底部并钉住，直到 virtua 把末尾条目测高、总高连续稳定。
  // 两帧 rAF 不够：估算高度下滚到的「底部」在测高后会变，钉住期间持续跟到真实底部。
  const pinToBottom = () => {
    stopPinning();
    pinningRef.current = true;
    let frames = 0;
    let lastSize = -1;
    let stableFrames = 0;
    const tick = () => {
      if (!pinningRef.current || frames >= PIN_MAX_FRAMES) {
        pinningRef.current = false;
        return;
      }
      frames += 1;
      const h = ref.current;
      const el = getScroller();
      if (h && el) {
        const atBottom = h.scrollOffset + h.viewportSize >= h.scrollSize - PIN_THRESHOLD;
        follow.toBottom(el);
        const size = h.scrollSize;
        stableFrames = atBottom && size === lastSize ? stableFrames + 1 : 0;
        lastSize = size;
        if (stableFrames >= 3) {
          pinningRef.current = false;
          return;
        }
      }
      pinRafRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  // 内容变化（新消息 / 流式增长）后贴底。用 layout effect：绘制前同步贴底，消除「先显旧位置再跳底」的一帧闪。
  useLayoutEffect(reconcile);

  // 会话切换（resetKey 变）或首次挂载：清掉旧锚点，钉在底部。
  useLayoutEffect(() => {
    anchorIndexRef.current = 0;
    anchorWithinRef.current = 0;
    notifyViewport();
    pinToBottom();
    return stopPinning;
    // 仅在会话标识变化时重置贴底；同会话内的增量贴底由上面的 useLayoutEffect(reconcile) 负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // 用户自己发出新消息：不管读者停在哪里，都回到底部继续跟随（DSH 同一约定）。
  const followKeyRef = useRef(followKey);
  useLayoutEffect(() => {
    const previous = followKeyRef.current;
    followKeyRef.current = followKey;
    if (followKey && followKey !== previous) pinToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followKey]);

  useEffect(() => () => follow.dispose(), [follow]);

  const displayRef = useRef(display);
  displayRef.current = display;
  useImperativeHandle(scrollRef, () => ({
    scrollBy(deltaY) {
      if (deltaY === 0) return;
      stopPinning();
      follow.noteIntent();
      ref.current?.scrollBy(deltaY);
    },
    scrollToItem(id) {
      const index = displayRef.current.findIndex((item) => item.id === id);
      if (index < 0) return;
      stopPinning();
      follow.noteIntent();
      ref.current?.scrollToIndex(index, { align: 'start' });
    },
    getRoot: () => containerRef.current,
    getScroller: () => {
      const el = containerRef.current?.firstElementChild;
      return el instanceof HTMLElement ? el : null;
    },
  }));

  // 读者手势与 scrollend 挂在滚动容器上：手势打断钉底、给随后的上移记上读者；是否离开底部仍由
  // scroll 落点和停手采样决定。指针按住（拖滚动条）期间一直算读者，松开在 window 上收。
  // scrollend 时读者停手，立即采样。内部滚动区自己的 scrollend 不冒泡，不会误采样。
  useEffect(() => {
    const el = containerRef.current?.firstElementChild;
    if (!(el instanceof HTMLElement)) return;
    const onIntent = (event: Event) => {
      if (event instanceof KeyboardEvent && !SCROLL_KEYS.has(event.key)) return;
      stopPinning();
      follow.noteIntent();
    };
    const onPointerDown = () => {
      stopPinning();
      follow.holdPointer(true);
    };
    const onPointerUp = () => follow.holdPointer(false);
    const onScrollEnd = (event: Event) => {
      if (event.target === el) follow.onScrollEnd(el);
    };
    for (const type of READING_INTENTS) el.addEventListener(type, onIntent, { passive: true, capture: true });
    el.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);
    el.addEventListener('scrollend', onScrollEnd);
    return () => {
      for (const type of READING_INTENTS) el.removeEventListener(type, onIntent, { capture: true });
      el.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      el.removeEventListener('scrollend', onScrollEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow]);

  // virtua 的跳变补偿（视口上方条目变高变矮时保持画面不跳）只在 _fixScrollJump 里调滚动容器的
  // scrollBy。贴在底部时内容缩短，浏览器已经钳制到新底部，virtua 判断「是否到边」又差一个小数像素，
  // 于是在钳制之上再相对滚一次，视图被推到底部上方，下一帧才被拉回——跑起来就是抖。
  // 跟随中（且读者没在滚）在它之后同一个任务里贴回底部，这一帧画出来就是对的；读者在看中部时不插手。
  useLayoutEffect(() => {
    const el = containerRef.current?.firstElementChild;
    // jsdom 没有 Element.scrollBy。
    if (!(el instanceof HTMLElement) || typeof el.scrollBy !== 'function') return;
    const nativeScrollBy = el.scrollBy.bind(el) as (options?: ScrollToOptions) => void;
    el.scrollBy = ((options?: ScrollToOptions) => {
      nativeScrollBy(options);
      follow.reconcile(el);
    }) as typeof el.scrollBy;
    return () => {
      delete (el as { scrollBy?: unknown }).scrollBy;
    };
  }, [follow]);

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

  // 内容总高变化（末尾条目测高、流式正文长高、懒加载内容撑开）时，跟随状态下跟到新的底部。
  // 视口自身的尺寸变化交给下面的 resize 逻辑，那段时间不在这里插手。
  useEffect(() => {
    const content = containerRef.current?.firstElementChild?.firstElementChild;
    if (!(content instanceof HTMLElement)) return;
    const ro = new ResizeObserver(() => {
      if (!resizingRef.current) reconcile();
    });
    ro.observe(content);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 视口尺寸变化（窗口压缩 / 面板折叠 / 文字重排）时保持位置。
  // 难点：virtua 在 resize 时按自身锚点逐帧重排，中部阅读位会抖；且重排触发的 scroll 会被当成读者移动。
  // 方案：resize 期间用 resizingRef 冻结锚点（scroll 回声只记账），按冻结前意图持续钉回——
  //   跟随：交给收尾一次性贴底（virtua 自身贴底重排是平滑的，逐帧滚反而打架）；
  //   不跟随：逐帧 scrollTo(锚点条目当前 offset + 偏移)，盖掉 virtua 的抖动，把阅读位钉死。
  //   收尾再钉一次确保最终位置准确，并延一帧解冻以避开程序化滚动自身触发的 scroll。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const restore = () => {
      const h = ref.current;
      if (!h) return;
      if (follow.active && !follow.pending) {
        reconcile();
      } else {
        // 用 scrollToIndex 而非 scrollTo：它保证锚点条目落入渲染范围，rapid resize 下即使条目高度暂时
        // 还是旧值也不会因 offset 越界而瞬间空白；align:'start'+offset 落点与原 scrollTo 等价。
        h.scrollToIndex(anchorIndexRef.current, { align: 'start', offset: anchorWithinRef.current });
      }
    };
    const ro = new ResizeObserver(() => {
      resizingRef.current = true;
      if (!follow.active || follow.pending) restore();
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

  const jumpToBottom = () => {
    if (countRef.current > 0) pinToBottom();
  };

  return (
    <div style={fillStyle(fill)}>
      <div
        ref={containerRef}
        data-testid={testId}
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, height: '100%' }}
      >
        <VList
          ref={ref}
          data={rows}
          className={styles.scroller}
          style={{ height: '100%', flex: 1, minHeight: 0 }}
          bufferSize={BUFFER_SIZE}
          onScroll={() => {
            const h = ref.current;
            const el = getScroller();
            if (!h || !el) return;
            // 钉底和 resize 期间的滚动都是程序自己造成的：记账，不当成读者移动，也不动锚点。
            if (resizingRef.current || pinningRef.current) {
              follow.acknowledge(el);
              return;
            }
            follow.onScroll(el);
            // 记录当前顶部可见条目作为锚点，供 resize 期间钉回阅读位置。
            anchorIndexRef.current = h.findItemIndex(h.scrollOffset);
            anchorWithinRef.current = h.scrollOffset - h.getItemOffset(anchorIndexRef.current);
            notifyViewport();
          }}
        >
          {(row: Row<T>) =>
            row === FOOTER_ROW ? (
              <div key={FOOTER_ROW}>
                {footer ? <div style={itemStyle}>{footer}</div> : null}
                {paddingBottom > 0 ? (
                  <div data-testid="seat-spacer" style={{ height: paddingBottom }} />
                ) : null}
              </div>
            ) : (
              <div key={row.id} data-find-item={row.id} style={itemStyle}>
                {renderItem(row)}
              </div>
            )
          }
        </VList>
      </div>
      {overlay?.(viewport)}
      {/* 「回到底部」只看跟随意图（DSH 同）：不跟随必然是读者滚离底部 25px 以上，列表一定可滚。
          不按条数判断——一整轮长回复加工具卡只算一行，按条数会让长会话永远没有这个按钮。 */}
      {!following ? (
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
