import { DraggablePanel } from '@lobehub/ui';
import { createStaticStyles, cx } from 'antd-style';
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';

type ResizePlacement = 'left' | 'right' | 'top' | 'bottom';

// DraggablePanel 的 <aside> 自身不设主轴外的尺寸，仅靠 flex 拉伸（height/width 为 auto），
// 导致内部 Resizable 的 height:100% 无法解析、内容塌陷。显式补足交叉轴尺寸让百分比链路可解析。
const styles = createStaticStyles(({ css }) => ({
  fillHeight: css`
    height: 100%;
    contain: layout style;
  `,
  fillWidth: css`
    width: 100%;
    contain: layout style;
  `,
  contentShell: css`
    width: 100%;
    height: 100%;
    overflow: hidden;
    contain: layout style paint;
  `,
  contentHidden: css`
    visibility: hidden;
    pointer-events: none;
  `,
  handle: css`
    position: absolute;
    z-index: 10;
    touch-action: none;
  `,
  handleLeft: css`
    inset-block: 0;
    inset-inline-start: 0;
    width: 5px;
    cursor: col-resize;
  `,
  handleRight: css`
    inset-block: 0;
    inset-inline-end: 0;
    width: 5px;
    cursor: col-resize;
  `,
  handleTop: css`
    inset-inline: 0;
    inset-block-start: 0;
    height: 5px;
    cursor: row-resize;
  `,
  handleBottom: css`
    inset-inline: 0;
    inset-block-end: 0;
    height: 5px;
    cursor: row-resize;
  `,
}));

/** 手柄在停靠边的反向边：停在右边的面板从左沿拖。 */
const HANDLE_CLASS: Record<ResizePlacement, string> = {
  right: styles.handleLeft,
  left: styles.handleRight,
  bottom: styles.handleTop,
  top: styles.handleBottom,
};

interface ResizeHandleProps {
  /** 停靠边；left/right 调宽，top/bottom 调高，拖拽手柄在反向边 */
  placement: ResizePlacement;
  /** 初始尺寸（宽或高，取决于 placement），通常来自 layoutStore */
  defaultSize: number;
  minSize: number;
  maxSize: number;
  /** 拖拽结束后回调，传回新的主轴尺寸（px 数值），用于持久化 */
  onResize: (size: number) => void;
  /** 拖拽过程中持续回调实时尺寸（px），用于让另一侧面板实时让位；结束时传 null 由 onResize 落定 */
  onResizeLive?: (size: number | null) => void;
  /**
   * 折叠/展开状态（受控）。为 false 时面板以 0.2s 动画收起到 0；省略时恒展开。
   * 启用后请让面板始终挂载（不要再用条件渲染包裹），否则没有动画。
   */
  expand?: boolean;
  /** DraggablePanel 折叠状态变化回调（自带手柄/hover 触发时） */
  onExpandChange?: (expand: boolean) => void;
  /**
   * 面板底色，需与 children 的实际背景一致。折叠/展开 0.2s 动画里 children 会淡到 opacity:0，
   * 此时露出的是 DraggablePanel 自身底色；不传则回退到 colorBgLayout（偏黑），与内容区
   * （colorBgContainer）形成黑色闪烁/割裂。传入匹配色即可让动画期间无色差。
   */
  backgroundColor?: string;
  children?: ReactNode;
}

/**
 * 可拖拽调整尺寸的停靠面板。
 *
 * 折叠动画和外观用 DraggablePanel，拖动自己做：DraggablePanel 内部的 re-resizable 每个 mousemove 都要
 * 往父节点插探测元素、改 flex-wrap 量父尺寸，再 flushSync 渲染、getBoundingClientRect 夹取，
 * 一帧里把两侧整页内容强制排版两三遍，长对话 + 长文档时拖动明显掉帧。
 * 这里只在 pointermove 里算新尺寸、写受控 size，排版留给浏览器每帧做一次。
 */
export function ResizeHandle({
  placement,
  defaultSize,
  minSize,
  maxSize,
  onResize,
  onResizeLive,
  expand = true,
  onExpandChange,
  backgroundColor,
  children,
}: ResizeHandleProps) {
  const isVertical = placement === 'top' || placement === 'bottom';
  // 受控 size：折叠(expand=false)时 DraggablePanel 内部把面板尺寸动画到 0（靠 styles.panel
  // 自带的 transition），展开时回到这里记录的尺寸，精确恢复用户拖拽过的宽/高（对齐 lobehub RightPanel）。
  const [size, setSize] = useState(defaultSize);
  const draggingRef = useRef(false);
  const frozenRef = useRef<{ raf: number; restore: () => void } | null>(null);
  // 双击手柄回到挂载时的尺寸（沿用 DraggablePanel 的行为）。
  const initialSizeRef = useRef(defaultSize);
  // 占满/还原会从外部改 defaultSize。拖拽过程中不要把本地尺寸拽回去。
  useEffect(() => {
    if (!draggingRef.current) setSize(defaultSize);
  }, [defaultSize]);
  // 渲染前把尺寸钳进 [minSize, maxSize]：maxSize 可能随容器（窗口/侧栏）收缩而变小，
  // 此时面板跟着缩回、贴齐参考边并收在窗口内；容器变大后又回到用户偏好的 size，不覆盖持久化值。
  const clampedSize = Math.min(Math.max(size, minSize), maxSize);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const origin = isVertical ? event.clientY : event.clientX;
    // 停在右 / 下边的面板，指针往左 / 上走是变大。
    const sign = placement === 'right' || placement === 'bottom' ? -1 : 1;
    const startSize = clampedSize;
    let latest = startSize;
    draggingRef.current = true;
    // 尺寸每帧都变：DraggablePanel 外层 0.2s 的宽 / 高过渡和 Resizable 的 transition: all 要先关掉，
    // 否则面板落后于指针，过渡期间每帧还要多排一次版。直接写这两个节点的 inline style：
    // 在 aside 上挂类再用子选择器命中它们，会让整棵面板子树的样式失效重算。
    // 双击时第二次按下可能早于上一次的恢复，沿用第一次存下的原值，否则会把 none 当原值存住。
    const pending = frozenRef.current;
    if (pending) {
      cancelAnimationFrame(pending.raf);
    } else {
      const resizable = handle.parentElement?.parentElement ?? null;
      const saved = [resizable, resizable?.parentElement ?? null]
        .filter((el): el is HTMLElement => el instanceof HTMLElement)
        .map((el) => [el, el.style.transition] as const);
      for (const [el] of saved) el.style.transition = 'none';
      frozenRef.current = {
        raf: 0,
        restore: () => {
          for (const [el, previous] of saved) el.style.transition = previous;
        },
      };
    }

    const move = (e: globalThis.PointerEvent) => {
      const pos = isVertical ? e.clientY : e.clientX;
      const next = Math.round(Math.min(Math.max(startSize + sign * (pos - origin), minSize), maxSize));
      if (next === latest) return;
      latest = next;
      setSize(next);
      onResizeLive?.(next);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      draggingRef.current = false;
      onResize(latest);
      onResizeLive?.(null);
      // 等落定的尺寸提交后再恢复过渡，免得最后一次写入被动画化。
      const frozen = frozenRef.current;
      if (frozen) {
        frozen.raf = requestAnimationFrame(() => {
          frozen.restore();
          frozenRef.current = null;
        });
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const resetSize = () => {
    const initial = Math.min(Math.max(initialSizeRef.current, minSize), maxSize);
    setSize(initial);
    onResize(initial);
  };

  return (
    <DraggablePanel
      mode="fixed"
      placement={placement}
      expandable={false}
      expand={expand}
      resize={false}
      backgroundColor={backgroundColor}
      className={isVertical ? styles.fillWidth : styles.fillHeight}
      size={isVertical ? { width: '100%', height: clampedSize } : { height: '100%', width: clampedSize }}
      minWidth={isVertical ? undefined : minSize}
      maxWidth={isVertical ? undefined : maxSize}
      minHeight={isVertical ? minSize : undefined}
      maxHeight={isVertical ? maxSize : undefined}
      onExpandChange={onExpandChange}
    >
      {expand ? (
        <div
          role="separator"
          aria-orientation={isVertical ? 'horizontal' : 'vertical'}
          className={cx(styles.handle, HANDLE_CLASS[placement])}
          data-testid={`resize-handle-${placement}`}
          onPointerDown={startDrag}
          onDoubleClick={resetSize}
        />
      ) : null}
      <div className={cx(styles.contentShell, !expand && styles.contentHidden)}>{children}</div>
    </DraggablePanel>
  );
}
