import { Flexbox } from '@lobehub/ui';
import { createStyles } from 'antd-style';

const useStyles = createStyles(({ token, css }) => ({
  container: css`
    background: ${token.colorBgContainer};
    height: 100%;
  `,
  header: css`
    height: 64px;
    border-bottom: 1px solid ${token.colorBorder};
    padding: 0 16px;
  `,
  content: css`
    flex: 1;
    min-height: 0;
    padding: 16px;
    color: ${token.colorTextSecondary};
  `,
}));

export function RightPanel() {
  const { styles } = useStyles();

  return (
    <Flexbox className={styles.container}>
      <Flexbox horizontal align="center" className={styles.header}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Panel</span>
      </Flexbox>
      <Flexbox className={styles.content}>
        <div>Right panel placeholder (tabs will be added in stage 4)</div>
      </Flexbox>
    </Flexbox>
  );
}
