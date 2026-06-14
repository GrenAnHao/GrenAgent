import { DraggablePanel, type DraggablePanelProps } from '@lobehub/ui';
import { createStaticStyles, cx } from 'antd-style';
import { useState, type ReactNode } from 'react';

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
}));

interface ResizeHandleProps {
  /** 停靠边；left/right 调宽，top/bottom 调高，拖拽手柄在反向边 */
  placement: ResizePlacement;
  /** 初始尺寸（宽或高，取决于 placement），通常来自 layoutStore */
  defaultSize: number;
  minSize: number;
  maxSize: number;
  /** 拖拽结束后回调，传回新的主轴尺寸（px 数值） */
  onResize: (size: number) => void;
  /**
   * 折叠/展开状态（受控）。为 false 时面板以 0.2s 动画收起到 0；省略时恒展开。
   * 启用后请让面板始终挂载（不要再用条件渲染包裹），否则没有动画。
   */
  expand?: boolean;
  /** DraggablePanel 折叠状态变化回调（自带手柄/hover 触发时） */
  onExpandChange?: (expand: boolean) => void;
  children?: ReactNode;
}

export function ResizeHandle({
  placement,
  defaultSize,
  minSize,
  maxSize,
  onResize,
  expand = true,
  onExpandChange,
  children,
}: ResizeHandleProps) {
  const isVertical = placement === 'top' || placement === 'bottom';
  // 受控 size：折叠(expand=false)时 DraggablePanel 内部把面板尺寸动画到 0（靠 styles.panel
  // 自带的 transition），展开时回到这里记录的尺寸，精确恢复用户拖拽过的宽/高（对齐 lobehub RightPanel）。
  const [size, setSize] = useState(defaultSize);

  const readMainSize = (
    next: { width?: string | number; height?: string | number } | undefined,
  ): number | undefined => {
    if (!next) return undefined;
    const raw = isVertical ? next.height : next.width;
    const value = typeof raw === 'number' ? raw : parseFloat(raw ?? '');
    return Number.isNaN(value) ? undefined : value;
  };

  // 拖拽过程中实时更新受控尺寸，否则受控值会在每次渲染把拖拽“拽回去”→表现为无法拖动。
  const handleSizeDragging: DraggablePanelProps['onSizeDragging'] = (_delta, next) => {
    const value = readMainSize(next);
    if (value != null) setSize(value);
  };

  // 拖拽结束时持久化到 layoutStore。
  const handleSizeChange: DraggablePanelProps['onSizeChange'] = (_delta, next) => {
    const value = readMainSize(next);
    if (value != null) {
      setSize(value);
      onResize(value);
    }
  };

  return (
    <DraggablePanel
      mode="fixed"
      placement={placement}
      expandable={false}
      expand={expand}
      className={isVertical ? styles.fillWidth : styles.fillHeight}
      size={isVertical ? { width: '100%', height: size } : { height: '100%', width: size }}
      minWidth={isVertical ? undefined : minSize}
      maxWidth={isVertical ? undefined : maxSize}
      minHeight={isVertical ? minSize : undefined}
      maxHeight={isVertical ? maxSize : undefined}
      onExpandChange={onExpandChange}
      onSizeDragging={handleSizeDragging}
      onSizeChange={handleSizeChange}
    >
      <div className={cx(styles.contentShell, !expand && styles.contentHidden)}>{children}</div>
    </DraggablePanel>
  );
}
