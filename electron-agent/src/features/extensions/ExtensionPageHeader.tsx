import { createStaticStyles, cssVar } from 'antd-style';
import { WorkbenchButton as Button } from '../../components/WorkbenchButton';
import { App } from 'antd';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { errorText } from './errorText';
import type { ReactNode } from 'react';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    margin-block-end: 18px;
    @container extensions-module (max-height: 560px) { margin-block-end: 10px; }
  `,
  copy: css`
    flex: 1 0 auto;
    min-width: 0;
    /* 各页有三到四个按钮；同一宽度统一换行，不让按钮数量决定标题栏高度。 */
    @container extensions-module (max-width: 500px) { flex-basis: 100%; }
  `,
  title: css`
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0;
    color: ${cssVar.colorText};
    font-size: var(--gren-font-heading);
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: -0.02em;
  `,
  count: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding-inline: 6px;
    border-radius: 6px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextSecondary};
    font-size: var(--gren-font-caption);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.01em;
  `,
  description: css`
    flex: 0 0 100%;
    min-width: 0;
    overflow-wrap: anywhere;
    color: ${cssVar.colorTextSecondary};
    font-size: var(--gren-font-secondary);
    line-height: 1.5;
    .font-mono { font-size: inherit; }
    .extension-metric { font-family:var(--font-mono); display: inline-block; margin-inline-start: 12px; color: ${cssVar.colorTextSecondary}; font-variant-numeric: tabular-nums; font-size: var(--gren-font-secondary); }
  `,
  actions: css`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
    button { height: 30px; padding-inline: 10px; border-radius: 7px; font-size: var(--gren-font-body); }
    @container extensions-module (max-width: 500px) {
      margin-inline-start: auto;
      gap: 4px;
      button { padding-inline: 6px; }
    }
    @container extensions-module (max-width: 400px) {
      /* 窄栏优先保留动作文字，不让技能的第 4 个动作单独换行。保留加载反馈。 */
      button:not(.ant-btn-loading) > .ant-btn-icon { display: none; }
    }
    @container extensions-module (max-width: 340px) {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      button:last-child { grid-column: 2; }
    }
  `,
}));

interface ExtensionPageHeaderProps {
  title: string;
  count?: number;
  description: ReactNode;
  actions?: ReactNode;
  id: string;
  onRefresh: () => Promise<void>;
  onDirectory: () => Promise<unknown>;
  metric?: string;
}

export function ExtensionPageHeader({ title, count, description, actions, id, onRefresh, onDirectory, metric }: ExtensionPageHeaderProps) {
  const { message } = App.useApp();
  const [refreshing, setRefreshing] = useState(false);
  async function refresh() {
    setRefreshing(true);
    try { await onRefresh(); } catch (e) { message.error(errorText(e)); } finally { setRefreshing(false); }
  }
  return (
    <header className={styles.root} data-testid="extension-page-header">
      <div className={styles.copy}>
        <h2 className={styles.title}>{title}{count !== undefined && <span className={styles.count}>{count}</span>}</h2>
      </div>
      <div className={styles.actions}>
        <Button loading={refreshing} data-testid={id + '-refresh'} aria-label={'刷新' + title} icon={<RefreshCw size={15} />} onClick={() => void refresh()}>刷新</Button>
        <Button data-testid={id + '-open-dir'} aria-label={'打开' + title + '目录'} icon={<FolderOpen size={15} />} onClick={() => void onDirectory().catch((e) => message.error(errorText(e)))}>打开目录</Button>
        {actions}
      </div>
      <div className={styles.description}>{description}{metric && <span className="extension-metric">{metric}</span>}</div>
    </header>
  );
}
