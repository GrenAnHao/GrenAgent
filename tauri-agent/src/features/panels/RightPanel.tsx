import { useEffect, useState } from 'react';
import { ActionIcon, Flexbox } from '@lobehub/ui';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import { PanelRightClose } from 'lucide-react';

import { PanelHeader } from '../../components/PanelHeader';
import { useAgentStore } from '../../stores/AgentStoreContext';
import type { ChatMessage } from '../../stores/agentReducer';
import { SubAgentConversation } from './SubAgentConversation';
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
    max-width: 160px;
    height: 26px;
    padding: 0 10px;
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

interface RightPanelProps {
  /** 收起右面板（显示为 header 折叠图标）。 */
  onCollapse?: () => void;
}

export function RightPanel({ onCollapse }: RightPanelProps) {
  const store = useAgentStore();
  const messages = store.useStore((s) => s.messages);
  const subAgents = messages.filter(
    (m): m is ToolMessage => m.kind === 'tool' && m.toolName === 'spawn_agent',
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  // 新子代理出现时默认切到最新；当前选中被移除时回退到最后一个。
  const latestId = subAgents.length ? subAgents[subAgents.length - 1].id : null;
  useEffect(() => {
    setActiveId((cur) => (cur && subAgents.some((s) => s.id === cur) ? cur : latestId));
  }, [latestId, subAgents]);

  const active = subAgents.find((s) => s.id === activeId) ?? subAgents[subAgents.length - 1];

  const collapseAction = onCollapse ? (
    <ActionIcon icon={PanelRightClose} title="Collapse panel" onClick={onCollapse} />
  ) : undefined;

  return (
    <Flexbox className={styles.container}>
      <PanelHeader title="子代理" actions={collapseAction} />
      {subAgents.length === 0 || !active ? (
        <div className={styles.empty} data-testid="subagent-panel">
          暂无子代理。用 <code>spawn_agent</code> 委派任务后，这里以独立 tab 实时显示每个子代理的对话。
        </div>
      ) : (
        <Flexbox flex={1} style={{ minHeight: 0 }} data-testid="subagent-panel">
          <div className={styles.tabBar} role="tablist">
            {subAgents.map((sa, i) => (
              <button
                key={sa.id}
                type="button"
                role="tab"
                aria-selected={sa.id === active.id}
                data-testid={`subagent-tab-${sa.toolCallId}`}
                className={cx(styles.tab, sa.id === active.id && styles.tabActive)}
                onClick={() => setActiveId(sa.id)}
              >
                <span className={styles.dot} style={{ background: statusColor(sa.status) }} />
                <span className={styles.tabLabel}>{`#${i + 1} ${taskLabel(sa.args)}`}</span>
              </button>
            ))}
          </div>
          <SubAgentConversation
            key={active.id}
            data-testid={`subagent-${active.toolCallId}`}
            task={taskLabel(active.args)}
            result={active.result}
            status={active.status}
          />
        </Flexbox>
      )}
    </Flexbox>
  );
}
