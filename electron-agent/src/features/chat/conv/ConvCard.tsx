import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import type { LucideIcon } from 'lucide-react';
import { memo, type ReactNode } from 'react';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillQuaternary};
  `,
  head: css`
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    color: ${cssVar.colorTextTertiary};
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  `,
  tag: css`
    margin-inline-start: auto;
    font-family: ${cssVar.fontFamilyCode};
    text-transform: none;
    color: ${cssVar.colorTextQuaternary};
  `,
  footer: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 9px 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
}));

interface ConvCardProps {
  icon?: LucideIcon;
  label: string;
  tag?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  'data-testid'?: string;
}

/** L4 卡片：统一 surface（与 ConvStrip 同底/边/圆角）+ 卡头 + body + footer 槽。 */
export const ConvCard = memo(function ConvCard({
  icon,
  label,
  tag,
  children,
  footer,
  'data-testid': testId,
}: ConvCardProps) {
  return (
    <div className={styles.card} data-testid={testId}>
      <div className={styles.head}>
        {icon ? <Icon icon={icon} size={12} /> : null}
        <span>{label}</span>
        {tag != null ? <span className={styles.tag}>{tag}</span> : null}
      </div>
      {children}
      {footer != null ? <div className={styles.footer}>{footer}</div> : null}
    </div>
  );
});
