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
    font-size: 14px;
    font-weight: 600;
    color: ${token.colorText};
    margin-block-end: 8px;
  `,
}));

interface Props {
  title?: string;
  children: ReactNode;
}

export function SettingCard({ title, children }: Props) {
  const { styles } = useStyles();
  return (
    <div className={styles.card} data-testid={title ? `set-card-${title}` : 'set-card'}>
      {title ? <div className={styles.title}>{title}</div> : null}
      {children}
    </div>
  );
}
