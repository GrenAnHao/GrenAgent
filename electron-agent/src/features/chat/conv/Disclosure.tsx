import { Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { ChevronRight } from 'lucide-react';
import { memo } from 'react';

const styles = createStaticStyles(({ css }) => ({
  chev: css`
    flex: none;
    color: ${cssVar.colorTextQuaternary};
    transition: transform 0.15s ease;
  `,
  open: css`
    transform: rotate(90deg);
  `,
}));

/** 统一折叠指示：一个会旋转的 chevron（替代 Collapse/Accordion/各自 chevron 三套）。 */
export const Disclosure = memo(function Disclosure({ open }: { open: boolean }) {
  return <Icon className={cx(styles.chev, open && styles.open)} icon={ChevronRight} size={12} />;
});
