import { ActionIcon, Flexbox, Icon } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { Globe, PanelRightClose, X } from 'lucide-react';

import { PanelHeader } from '../../components/PanelHeader';
import { useAgentStore } from '../../stores/AgentStoreContext';
import type { ChatMessage } from '../../stores/agentReducer';
import { useRightPanelStore, type PageView } from '../../stores/rightPanelStore';
import { SubAgentConversation } from './SubAgentConversation';
import { PageContentViewer } from './PageContentViewer';
import { taskLabel } from './subagentUtils';

const styles = createStaticStyles(({ css }) => ({
  container: css`
    background: ${cssVar.colorBgContainer};
    height: 100%;
  `,
  empty: css`
    flex: 1;
    padding: 12px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  tabBar: css`
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    &::-webkit-scrollbar {
      display: none;
    }
  `,
  tab: css`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 180px;
    height: 26px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  tabActive: css`
    background: ${cssVar.colorFillSecondary};
    color: ${cssVar.colorText};
  `,
  tabLabel: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  tabClose: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    margin-inline-start: 2px;
    border-radius: 4px;
    color: ${cssVar.colorTextTertiary};

    &:hover {
      background: ${cssVar.colorFillTertiary};
      color: ${cssVar.colorText};
    }
  `,
  dot: css`
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    border-radius: 50%;
  `,
}));

type ToolMessage = Extract<ChatMessage, { kind: 'tool' }>;

function statusColor(status: ToolMessage['status']): string {
  if (status === 'running') return '#fbbf24';
  if (status === 'error') return '#f87171';
  return '#4ade80';
}

type PanelTab =
  | { id: string; kind: 'subagent'; title: string; sa: ToolMessage }
  | { id: string; kind: 'page'; title: string; page: PageView };

interface RightPanelProps {
  /** 收起右面板（显示为 header 折叠图标）。 */
  onCollapse?: () => void;
}

/** 通用右侧 TabControl：子代理对话与抓取页面等各占一个可切换/关闭的 tab。 */
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

  // 选中：显式选中优先，否则回退到最后一个 tab（新内容默认聚焦）。
  const active = tabs.find((t) => t.id === activeId) ?? tabs.at(-1) ?? null;

  const collapseAction = onCollapse ? (
    <ActionIcon icon={PanelRightClose} title="Collapse panel" onClick={onCollapse} />
  ) : undefined;

  return (
    <Flexbox className={styles.container}>
      <PanelHeader title="面板" actions={collapseAction} />
      {tabs.length === 0 || !active ? (
        <div className={styles.empty} data-testid="subagent-panel">
          暂无内容。点击工具卡片（如 fetch_url 结果）或用 <code>spawn_agent</code> 委派任务，
          会在这里以独立 tab 打开。
        </div>
      ) : (
        <Flexbox flex={1} style={{ minHeight: 0 }} data-testid="subagent-panel">
          <div className={styles.tabBar} role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === active.id}
                data-testid={
                  t.kind === 'subagent' ? `subagent-tab-${t.sa.toolCallId}` : `page-tab-${t.id}`
                }
                className={cx(styles.tab, t.id === active.id && styles.tabActive)}
                onClick={() => setActive(t.id)}
              >
                {t.kind === 'subagent' ? (
                  <span className={styles.dot} style={{ background: statusColor(t.sa.status) }} />
                ) : (
                  <Icon icon={Globe} size={12} style={{ flex: 'none' }} />
                )}
                <span className={styles.tabLabel}>{t.title}</span>
                {t.kind === 'page' ? (
                  <span
                    className={styles.tabClose}
                    role="button"
                    aria-label="关闭"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                  >
                    <Icon icon={X} size={11} />
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          {active.kind === 'subagent' ? (
            <SubAgentConversation
              key={active.id}
              data-testid={`subagent-${active.sa.toolCallId}`}
              task={taskLabel(active.sa.args)}
              result={active.sa.result}
              status={active.sa.status}
            />
          ) : (
            <PageContentViewer key={active.id} page={active.page} onClose={() => closeTab(active.id)} />
          )}
        </Flexbox>
      )}
    </Flexbox>
  );
}
