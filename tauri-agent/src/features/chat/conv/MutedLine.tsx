import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import type { LucideIcon } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Disclosure } from './Disclosure';

const styles = createStaticStyles(({ css }) => ({
  line: css`
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    padding: 0;
    border: none;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    font-size: 13px;
    line-height: 1.5;
    cursor: pointer;
    transition: color 0.12s ease;

    &:hover {
      color: ${cssVar.colorTextSecondary};
    }
  `,
  count: css`
    color: ${cssVar.colorTextQuaternary};
  `,
}));

interface MutedLineProps {
  icon: LucideIcon;
  text: ReactNode;
  count?: number;
  open?: boolean;
  onToggle?: () => void;
  'data-testid'?: string;
}

/** L1 低调行：环境信息（深度思考 / 注入），最弱权重；可折叠则带 chevron。 */
export const MutedLine = memo(function MutedLine({
  icon,
  text,
  count,
  open = false,
  onToggle,
  'data-testid': testId,
}: MutedLineProps) {
  return (
    <button
      type="button"
      className={styles.line}
      data-testid={testId}
      aria-expanded={onToggle ? open : undefined}
      onClick={onToggle}
    >
      <Icon icon={icon} size={12} />
      <span>
        {text}
        {count ? <span className={styles.count}> · {count} 条</span> : null}
      </span>
      {onToggle ? <Disclosure open={open} /> : null}
    </button>
  );
});
