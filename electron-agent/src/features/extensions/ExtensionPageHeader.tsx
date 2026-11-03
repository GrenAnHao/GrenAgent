import { createStaticStyles, cssVar } from 'antd-style';
import type { ReactNode } from 'react';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 14px 20px;
    margin-block-end: 24px;
  `,
  copy: css`
    flex: 1 1 200px;
    min-width: 0;
  `,
  title: css`
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0;
    color: ${cssVar.colorText};
    font-size: 24px;
    font-weight: 500;
    line-height: 1.35;
    letter-spacing: -0.02em;
  `,
  count: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 22px;
    padding-inline: 6px;
    border-radius: 6px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    font-weight: 400;
    letter-spacing: 0;
  `,
  description: css`
    margin-block-start: 7px;
    color: ${cssVar.colorTextSecondary};
    font-size: 13px;
    line-height: 1.6;
  `,
  actions: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
  `,
}));

interface ExtensionPageHeaderProps {
  title: string;
  count?: number;
  description: ReactNode;
  actions?: ReactNode;
}

export function ExtensionPageHeader({ title, count, description, actions }: ExtensionPageHeaderProps) {
  return (
    <header className={styles.root} data-testid="extension-page-header">
      <div className={styles.copy}>
        <h2 className={styles.title}>{title}{count !== undefined ? <span className={styles.count}>{count}</span> : null}</h2>
        <div className={styles.description}>{description}</div>
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}
