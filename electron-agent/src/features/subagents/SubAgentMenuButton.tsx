import { ActionIcon, Icon } from '@lobehub/ui';
import { Popover } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Bot, Eraser } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { pi, type SubAgentItem } from '../../lib/pi';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { useDockStore } from '../../stores/dockStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { useSubAgentLiveStore, selectSubAgentList } from '../../stores/subagentLiveStore';
import { mapSubAgentStatus, subAgentId } from '../panels/subagentUtils';
import { SubAgentCard } from './SubAgentCard';

// 终态（完成/失败/取消）结束这么久后自动从列表淡出（总览面板比输入框托盘给更久的回看窗口）。
const FADE_MS = 300_000;
// 折叠：默认最多显示这么多个最近终态，更旧的收进「显示全部」。
const RECENT_TERMINAL = 4;

function isTerminalStatus(status: string): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled';
}

// 「清除已结束」：按 workspace 在 localStorage 记一个 cutoff 时刻，更新时刻早于它的终态一律隐藏。
// 纯前端、持久（重启仍生效），不删 registry 行（其他工具/CLI 仍可访问历史）。
function clearCutoffKey(ws: string): string {
  return `subagent-clear-cutoff:${ws}`;
}
function readClearCutoff(ws: string): number {
  if (!ws) return 0;
  const v = Number(localStorage.getItem(clearCutoffKey(ws)) ?? '0');
  return Number.isFinite(v) ? v : 0;
}

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
  headerTitle: css`
    display: flex;
    flex: 1;
    align-items: center;
    gap: 8px;
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
  moreBtn: css`
    padding: 6px;
    border: 1px dashed ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-align: center;
    cursor: pointer;

    &:hover {
      color: ${cssVar.colorText};
      border-color: ${cssVar.colorBorder};
    }
  `,
}));

/**
 * 顶部工具栏的子代理入口：放在命令行按钮左侧，图标带运行中角标。
 * 点击向下弹出当前工作区子代理卡片列表（数据来自 .pi/subagents/registry.db，轮询刷新）。
 * 点击卡片在右坞打开会话：优先复用主对话消息的完整 transcript，跨会话则由面板按需拉取。
 */
export function SubAgentMenuButton() {
  const ctx = useOptionalAgentStoreContext();
  const workspace = ctx?.workspace ?? '';
  const store = ctx?.store ?? null;
  const [open, setOpen] = useState(false);
  const [clearCutoff, setClearCutoff] = useState(0);
  const [showAll, setShowAll] = useState(false);

  // 订阅 subagentLiveStore 单例（不再自行 setInterval 轮询）
  const startPolling = useSubAgentLiveStore((s) => s.startPolling);
  // 稳定化 selector 引用，避免每次渲染传入新函数导致 Zustand/useSyncExternalStore 无限循环。
  const listSelector = useMemo(() => selectSubAgentList(workspace), [workspace]);
  const items = useSubAgentLiveStore(listSelector);

  useEffect(() => {
    if (!workspace) return;
    return startPolling(workspace);
  }, [workspace, startPolling]);

  // workspace 切换时重读该工作区的「清除」cutoff，并重置展开态。
  useEffect(() => {
    setClearCutoff(readClearCutoff(workspace));
    setShowAll(false);
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
      // 兜底：跨会话 / 后台 spawn。transcript 不再从列表携带，
      // SubAgentConversation 会通过 workspace + agentId 按需拉取。
      useDockStore.getState().openSubAgentLog({
        agentId: item.id,
        task: item.task,
        output: item.output ?? '',
        status: mapSubAgentStatus(item.status),
      });
    },
    [store],
  );

  const stopAgent = useCallback(
    (item: SubAgentItem) => {
      void pi.subagentCancel(workspace, item.id);
    },
    [workspace],
  );

  const runningCount = items.filter((i) => i.status === 'running').length;

  const now = Date.now();
  // 可见性：运行中恒显示；终态需未被「清除」(updatedAt > cutoff) 且未超过淡出窗口。
  const visible = items.filter((item) => {
    if (item.status === 'running') return true;
    if (!isTerminalStatus(item.status)) return true;
    if (item.updatedAt <= clearCutoff) return false;
    return now - item.updatedAt <= FADE_MS;
  });
  const runningItems = visible.filter((i) => i.status === 'running');
  const terminalItems = visible.filter((i) => i.status !== 'running');
  const shownTerminal = showAll ? terminalItems : terminalItems.slice(0, RECENT_TERMINAL);
  const hiddenCount = terminalItems.length - shownTerminal.length;
  const hasClearable = items.some((i) => isTerminalStatus(i.status) && i.updatedAt > clearCutoff);

  const clearFinished = () => {
    const ts = Date.now();
    if (workspace) localStorage.setItem(clearCutoffKey(workspace), String(ts));
    setClearCutoff(ts);
    setShowAll(false);
  };

  const renderCard = (item: SubAgentItem) => (
    <SubAgentCard key={item.id} item={item} onOpen={() => openAgent(item)} onStop={() => stopAgent(item)} />
  );

  const content = (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          <Icon icon={Bot} size={16} />
          <span>
            子代理 <span className={styles.count}>· {visible.length}</span>
          </span>
        </span>
        {hasClearable ? (
          <ActionIcon icon={Eraser} size="small" title="清除已结束" onClick={clearFinished} />
        ) : null}
      </div>
      {visible.length === 0 ? (
        <div className={styles.empty}>暂无子代理。用 spawn_agent 委派任务后会在这里出现。</div>
      ) : (
        <div className={styles.list}>
          {runningItems.map(renderCard)}
          {shownTerminal.map(renderCard)}
          {hiddenCount > 0 ? (
            <div className={styles.moreBtn} onClick={() => setShowAll(true)}>
              显示全部（还有 {hiddenCount} 个已结束）
            </div>
          ) : null}
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
        title={`子代理（${runningCount} 运行中 / 共 ${visible.length}）`}
        data-testid="subagent-menu-button"
      />
    </Popover>
  );
}
