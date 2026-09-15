import { createStyles } from 'antd-style';
import type { ReactNode } from 'react';

const useStyles = createStyles(({ css, token }) => ({
  card: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillQuaternary};
    padding: 16px 20px;
    margin-block-end: 16px;
  `,
  title: css`
    font-size: var(--pi-font-size, 14px);
    font-weight: 600;
    color: ${token.colorText};
    margin-block-end: 8px;
  `,
  titleWithDesc: css`
    margin-block-end: 4px;
  `,
  desc: css`
    font-size: var(--pi-font-size-secondary, 13px);
    color: ${token.colorTextDescription};
    margin-block-end: 8px;
    line-height: calc(20px + var(--pi-font-delta-secondary, 0px));
  `,
}));

interface Props {
  title?: string;
  desc?: ReactNode;
  children: ReactNode;
}

export function SettingCard({ title, desc, children }: Props) {
  const { styles, cx } = useStyles();
  return (
    <div className={styles.card} data-testid={title ? `set-card-${title}` : 'set-card'}>
      {title ? <div className={cx(styles.title, desc && styles.titleWithDesc)}>{title}</div> : null}
      {desc ? <div className={styles.desc}>{desc}</div> : null}
      {children}
    </div>
  );
}
