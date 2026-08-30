import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import type { LucideIcon } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Disclosure } from './Disclosure';
import { StatusGlyph, type ConvStatus } from './StatusGlyph';

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    align-items: center;
    gap: 7px;
    height: 26px;
    padding: 0 7px;
    margin: 0 -7px;
    border-radius: 6px;
    font-size: 12.5px;
    transition: background 0.12s ease;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  clickable: css`
    cursor: pointer;
  `,
  name: css`
    flex: none;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  sep: css`
    color: ${cssVar.colorTextQuaternary};
  `,
  arg: css`
    overflow: hidden;
    min-width: 0;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 11.5px;
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  right: css`
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    margin-inline-start: auto;
  `,
  meta: css`
    font-size: 11px;
    color: ${cssVar.colorTextQuaternary};
    font-variant-numeric: tabular-nums;
  `,
  body: css`
    margin: 2px 0 8px 24px;
  `,
}));

interface ConvRowProps {
  status: ConvStatus;
  icon: LucideIcon;
  /** 名称：通常是等宽工具名，也可传富标题片段（如「搜索 <高亮词>」）。 */
  name: ReactNode;
  args?: ReactNode;
  meta?: ReactNode;
  /** 提供 body 即可展开；不提供则为纯展示行（无 chevron）。 */
  body?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  'data-testid'?: string;
}

/** L2 纯行：状态图标 + 工具图标 + 等宽名·参数 + 右侧 meta + 折叠箭头；展开 body 轻缩进、无左竖线。 */
export const ConvRow = memo(function ConvRow({
  status,
  icon,
  name,
  args,
  meta,
  body,
  open = false,
  onToggle,
  'data-testid': testId,
}: ConvRowProps) {
  const expandable = body != null && onToggle != null;
  return (
    <div data-testid={testId}>
      <div
        className={cx(styles.row, expandable && styles.clickable)}
        onClick={expandable ? onToggle : undefined}
      >
        <StatusGlyph status={status} />
        <Icon icon={icon} size={14} style={{ color: cssVar.colorTextTertiary, flex: 'none' }} />
        <span className={styles.name}>{name}</span>
        {args != null ? (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.arg}>{args}</span>
          </>
        ) : null}
        <div className={styles.right}>
          {meta != null ? <span className={styles.meta}>{meta}</span> : null}
          {expandable ? <Disclosure open={open} /> : null}
        </div>
      </div>
      {expandable && open ? <div className={styles.body}>{body}</div> : null}
    </div>
  );
});
