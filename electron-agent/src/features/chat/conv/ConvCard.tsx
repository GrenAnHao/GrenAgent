import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import type { LucideIcon } from 'lucide-react';
import { memo, type ReactNode } from 'react';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
  `,
  // 对话流内用近透明填充；浮层不用，避免圆角外露出灰角。
  plain: css`
    background: ${cssVar.colorFillQuaternary};
  `,
  head: css`
    display: flex;
    flex: none;
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
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 9px 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  // 浮在 Composer 上时与输入框同一套抬升面，避免近透明填充把会话正文透出来。
  elevated: css`
    flex: 1 1 auto;
    max-height: inherit;
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgElevated};
    box-shadow: ${cssVar.boxShadowSecondary};
  `,
}));

interface ConvCardProps {
  icon?: LucideIcon;
  label: string;
  tag?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  elevated?: boolean;
  'data-testid'?: string;
}

/** L4 卡片：统一 surface（与 ConvStrip 同底/边/圆角）+ 卡头 + body + footer 槽。 */
export const ConvCard = memo(function ConvCard({
  icon,
  label,
  tag,
  children,
  footer,
  elevated,
  'data-testid': testId,
}: ConvCardProps) {
  return (
    <div
      className={cx(styles.card, elevated ? styles.elevated : styles.plain)}
      data-surface={elevated ? 'elevated' : 'plain'}
      data-testid={testId}
    >
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
