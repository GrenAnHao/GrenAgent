import { ActionIcon, Flexbox, Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Globe, PanelRightClose, X } from 'lucide-react';

import { useAgentStore } from '../../stores/AgentStoreContext';
import type { ChatMessage } from '../../stores/agentReducer';
import { useRightPanelStore, type PageView } from '../../stores/rightPanelStore';
import { SubAgentConversation } from './SubAgentConversation';
import { PageContentViewer } from './PageContentViewer';
import { taskLabel } from './subagentUtils';

// Tab styling mirrors the terminal panel (TerminalPanel.tsx) for a consistent look.
const styles = createStaticStyles(({ css }) => ({
  container: css`
    height: 100%;
    min-height: 0;
    background: ${cssVar.colorBgContainer};
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 8px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorBgElevated};
  `,
  tabs: css`
    display: flex;
    align-items: center;
    gap: 4px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  `,
  tab: css`
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 180px;
    height: 28px;
    padding: 0 4px 0 12px;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    cursor: pointer;
    user-select: none;

    &:hover {
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorText};
    }
  `,
  tabActive: css`
    border-color: ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorFill};
    color: ${cssVar.colorText};
  `,
  tabTitle: css`
    overflow: hidden;
    flex: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  tabClose: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;

    &:hover {
      background: ${cssVar.colorFillSecondary};
      color: ${cssVar.colorText};
    }
  `,
  // Reserve the close slot on non-closable tabs so titles line up across tabs.
  tabCloseSpacer: css`
    width: 4px;
    flex: none;
  `,
  statusDot: css`
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: ${cssVar.colorTextQuaternary};
  `,
  statusDone: css`
    background: ${cssVar.colorSuccess};
  `,
  statusRunning: css`
    background: ${cssVar.colorWarning};
  `,
  statusError: css`
    background: ${cssVar.colorError};
  `,
  empty: css`
    flex: 1;
    padding: 12px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

type ToolMessage = Extract<ChatMessage, { kind: 'tool' }>;

function subAgentDotClass(status: ToolMessage['status']): string {
  return cx(
    styles.statusDot,
    status === 'done' && styles.statusDone,
    status === 'running' && styles.statusRunning,
    status === 'error' && styles.statusError,
  );
}

type PanelTab =
  | { id: string; kind: 'subagent'; title: string; sa: ToolMessage }
  | { id: string; kind: 'page'; title: string; page: PageView };

interface RightPanelProps {
  /** 收起右面板（显示为 header 折叠图标）。 */
  onCollapse?: () => void;
}

/** 通用右侧 TabControl：子代理对话与抓取页面等各占一个可切换/关闭的 tab（样式对齐终端面板）。 */
export function RightPanel({ onCollapse }: RightPanelProps) {
  const store = useAgentStore();
  const messages = store.useStore((s) => s.messages);
  const pageTabs = useRightPanelStore((s) => s.pageTabs);
  const activeId = useRightPanelStore((s) => s.activeId);
  const setActive = useRightPanelStore((s) => s.setActive);
  const closeTab = useRightPanelStore((s) => s.closeTab);

  const subAgents = messages.filter(
    (m): m is ToolMessage => m.kind === 'tool' && m.toolName === 'spawn_agent',
  );

  const tabs: PanelTab[] = [
    ...subAgents.map(
      (sa, i): PanelTab => ({
        id: sa.id,
        kind: 'subagent',
        title: `#${i + 1} ${taskLabel(sa.args)}`,
        sa,
      }),
    ),
    ...pageTabs.map((t): PanelTab => ({ id: t.id, kind: 'page', title: t.title, page: t.page })),
  ];

  const active = tabs.find((t) => t.id === activeId) ?? tabs.at(-1) ?? null;

  return (
    <Flexbox className={styles.container}>
      <div className={styles.header}>
        <div className={styles.tabs} role="tablist">
          {tabs.map((t) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === active?.id}
              data-testid={
                t.kind === 'subagent' ? `subagent-tab-${t.sa.toolCallId}` : `page-tab-${t.id}`
              }
              className={cx(styles.tab, t.id === active?.id && styles.tabActive)}
              onClick={() => setActive(t.id)}
            >
              {t.kind === 'subagent' ? (
                <span className={subAgentDotClass(t.sa.status)} />
              ) : (
                <Icon icon={Globe} size={12} style={{ flex: 'none' }} />
              )}
              <span className={styles.tabTitle}>{t.title}</span>
              {t.kind === 'page' ? (
                <button
                  type="button"
                  className={styles.tabClose}
                  title="关闭"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  <X size={12} />
                </button>
              ) : (
                <span className={styles.tabCloseSpacer} />
              )}
            </div>
          ))}
        </div>
        {onCollapse ? (
          <ActionIcon icon={PanelRightClose} size="small" title="Collapse panel" onClick={onCollapse} />
        ) : null}
      </div>

      {active ? (
        active.kind === 'subagent' ? (
          <SubAgentConversation
            key={active.id}
            data-testid={`subagent-${active.sa.toolCallId}`}
            task={taskLabel(active.sa.args)}
            result={active.sa.result}
            status={active.sa.status}
          />
        ) : (
          <PageContentViewer key={active.id} page={active.page} onClose={() => closeTab(active.id)} />
        )
      ) : (
        <div className={styles.empty} data-testid="subagent-panel">
          暂无内容。点击工具卡片（如 fetch_url 结果）或用 <code>spawn_agent</code> 委派任务，
          会在这里以独立 tab 打开。
        </div>
      )}
    </Flexbox>
  );
}
