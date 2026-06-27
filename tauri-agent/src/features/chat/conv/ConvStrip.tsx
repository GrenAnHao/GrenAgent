import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import type { LucideIcon } from 'lucide-react';
import { memo, type MouseEvent, type ReactNode } from 'react';
import { Disclosure } from './Disclosure';
import { StatusGlyph, type ConvStatus } from './StatusGlyph';

const styles = createStaticStyles(({ css }) => ({
  strip: css`
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    margin-block: 2px;
    padding: 0 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
    font-size: 12.5px;
    cursor: pointer;
    transition: border-color 0.12s ease;

    &:hover {
      border-color: ${cssVar.colorBorder};
    }
  `,
  title: css`
    flex: none;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  num: css`
    flex: none;
    font-family: ${cssVar.fontFamilyCode};
    font-size: 11.5px;
    color: ${cssVar.colorTextTertiary};
  `,
  chip: css`
    overflow: hidden;
    min-width: 0;
    padding: 1px 7px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 4px;
    background: ${cssVar.colorFillTertiary};
    font-family: ${cssVar.fontFamilyCode};
    font-size: 11px;
    color: ${cssVar.colorTextSecondary};
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
    color: ${cssVar.colorTextTertiary};
    white-space: nowrap;
  `,
}));

interface ConvStripProps {
  status: ConvStatus;
  icon: LucideIcon;
  title: string;
  num?: string;
  chip?: ReactNode;
  meta?: ReactNode;
  /** 右侧操作（停止 / 打开右坞等）；点击不冒泡到整条 toggle。 */
  actions?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
  'data-testid'?: string;
}

/** L3 横条：整条 surface（底 + hairline + 圆角）单行，给侧重组件（子代理）以存在感。 */
export const ConvStrip = memo(function ConvStrip({
  status,
  icon,
  title,
  num,
  chip,
  meta,
  actions,
  open = false,
  onToggle,
  'data-testid': testId,
}: ConvStripProps) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <div className={styles.strip} data-testid={testId} onClick={onToggle}>
      <StatusGlyph status={status} />
      <Icon icon={icon} size={14} style={{ color: cssVar.colorInfo, flex: 'none' }} />
      <span className={styles.title}>{title}</span>
      {num ? <span className={styles.num}>{num}</span> : null}
      {chip != null ? <span className={styles.chip}>{chip}</span> : null}
      <div className={styles.right} onClick={stop}>
        {meta != null ? <span className={styles.meta}>{meta}</span> : null}
        {actions}
        {onToggle ? <Disclosure open={open} /> : null}
      </div>
    </div>
  );
});
