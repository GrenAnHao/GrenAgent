import { Flexbox } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import type { ReactNode } from 'react';

interface ManagerLayoutProps {
  header: ReactNode;
  list: ReactNode;
  detail: ReactNode;
  testId?: string;
}

const styles = createStaticStyles(({ css }) => ({
  root: css`
    height: 100%;
    min-height: 0;
  `,
  header: css`
    flex: 0 0 auto;
    padding: 10px 14px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  body: css`
    min-height: 0;
  `,
  list: css`
    width: 260px;
    flex: 0 0 auto;
    height: 100%;
    overflow-y: auto;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};
    scrollbar-width: thin;
  `,
  detail: css`
    flex: 1;
    min-width: 0;
    height: 100%;
    overflow-y: auto;
    padding: 16px;
  `,
}));

export function ManagerLayout({ header, list, detail, testId }: ManagerLayoutProps) {
  return (
    <Flexbox className={styles.root} data-testid={testId ?? 'manager-layout'}>
      <div className={styles.header}>{header}</div>
      <Flexbox horizontal flex={1} className={styles.body}>
        <div className={styles.list}>{list}</div>
        <div className={styles.detail}>{detail}</div>
      </Flexbox>
    </Flexbox>
  );
}
