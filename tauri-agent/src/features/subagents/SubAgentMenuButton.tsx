import { ActionIcon, Icon } from '@lobehub/ui';
import { Popover } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Bot } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { pi, type SubAgentItem } from '../../lib/pi';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { subAgentId } from '../panels/subagentUtils';
import { SubAgentCard } from './SubAgentCard';

const POLL_MS = 2500;

const styles = createStaticStyles(({ css }) => ({
  panel: css`
    display: flex;
    flex-direction: column;
    width: 340px;
    max-width: calc(100vw - 40px);
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 4px 8px;
    font-size: 13px;
    font-weight: 600;
    color: ${cssVar.colorText};
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  count: css`
    font-weight: 400;
    color: ${cssVar.colorTextTertiary};
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: min(60vh, 520px);
    padding-block-start: 8px;
    overflow-y: auto;
  `,
  empty: css`
    padding: 16px 4px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-align: center;
  `,
}));

/** registry 状态 → SubAgentConversation 的三态。 */
function mapStatus(status: string): 'running' | 'done' | 'error' {
  if (status === 'running') return 'running';
  if (status === 'error' || status === 'cancelled') return 'error';
  return 'done';
}

/** 列表签名：仅在子代理集合 / 状态 / 活跃时间变化时才触发渲染。 */
function signature(items: SubAgentItem[]): string {
  return items.map((i) => `${i.id}:${i.status}:${i.updatedAt}`).join('|');
}

/**
 * 顶部工具栏的子代理入口：放在命令行按钮左侧，图标带运行中角标。
 * 点击向下弹出当前工作区子代理卡片列表（数据来自 .pi/subagents/registry.db，轮询刷新）。
 * 点击卡片在右坞打开会话：优先复用主对话消息的完整 transcript，跨会话则用 registry output 兜底。
 */
export function SubAgentMenuButton() {
  const ctx = useOptionalAgentStoreContext();
  const workspace = ctx?.workspace ?? '';
  const store = ctx?.store ?? null;
  const [items, setItems] = useState<SubAgentItem[]>([]);
  const [open, setOpen] = useState(false);
  const sigRef = useRef('');

  useEffect(() => {
    if (!workspace) {
      setItems([]);
      sigRef.current = '';
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const rows = await pi.subagentList(workspace);
        if (cancelled) return;
        const sig = signature(rows);
        if (sig !== sigRef.current) {
          sigRef.current = sig;
          setItems(rows);
        }
      } catch {
        // 跨进程读 registry 偶发 SQLITE_BUSY：保留上次结果，下个 tick 再试。
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspace]);

  const openAgent = useCallback(
    (item: SubAgentItem) => {
      setOpen(false);
      // 优先：主对话里能按 agentId 匹配到 spawn_agent 消息 → 用现有右坞 tab（含完整 transcript）。
      const messages = store?.useStore.getState().messages ?? [];
      const matched = messages.find(
        (m) => m.kind === 'tool' && m.toolName === 'spawn_agent' && subAgentId(m.result) === item.id,
      );
      if (matched) {
        useDockStore.getState().setActive('right', matched.id);
        useLayoutStore.getState().setRightPanelOpen(true);
        return;
      }
      // 兜底：跨会话 / 后台 spawn，用 registry 的最终 output 文本打开简版会话。
      useDockStore.getState().openSubAgentLog({
        agentId: item.id,
        task: item.task,
        output: item.output ?? '',
        status: mapStatus(item.status),
      });
    },
    [store],
  );

  const stopAgent = useCallback(
    (item: SubAgentItem) => {
      void pi.subagentCancel(workspace, item.id);
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: 'cancelled' } : i)));
    },
    [workspace],
  );

  const runningCount = items.filter((i) => i.status === 'running').length;

  const content = (
    <div className={styles.panel}>
      <div className={styles.header}>
        <Icon icon={Bot} size={16} />
        <span>
          子代理 <span className={styles.count}>· {items.length}</span>
        </span>
      </div>
      {items.length === 0 ? (
        <div className={styles.empty}>暂无子代理。用 spawn_agent 委派任务后会在这里出现。</div>
      ) : (
        <div className={styles.list}>
          {items.map((item) => (
            <SubAgentCard
              key={item.id}
              item={item}
              onOpen={() => openAgent(item)}
              onStop={() => stopAgent(item)}
            />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      arrow={false}
      content={content}
      styles={{ content: { padding: 8 } }}
    >
      <ActionIcon
        icon={Bot}
        size="small"
        active={open}
        title={`子代理（${runningCount} 运行中 / 共 ${items.length}）`}
        data-testid="subagent-menu-button"
      />
    </Popover>
  );
}
