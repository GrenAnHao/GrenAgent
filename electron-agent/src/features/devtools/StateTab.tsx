import { useMemo, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import { useSessionStore } from '../../store';
import { useModuleStore } from '../../stores/moduleStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { useDockStore } from '../../stores/dockStore';
import { useThemeStore } from '../../stores/themeStore';
import { useVisualStore } from '../../stores/visualStore';
import { useAgentRegistryStore } from '../../stores/agentStoreRegistry';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { styles } from './devtoolsStyles';
import { prettyJson, summarize } from './devtoolsFormat';

interface StoreSource {
  id: string;
  label: string;
  read: () => unknown;
}

export function StateTab() {
  const agentCtx = useOptionalAgentStoreContext();
  const [activeId, setActiveId] = useState('session');
  const [tick, setTick] = useState(0);
  const [copied, setCopied] = useState(false);

  const sources = useMemo<StoreSource[]>(
    () => [
      { id: 'session', label: 'sessionStore（工作区/会话列表）', read: () => useSessionStore.getState() },
      { id: 'agent', label: 'agentStore（当前对话消息流）', read: () => agentCtx?.store.useStore.getState() ?? null },
      { id: 'agentRegistry', label: 'agentStoreRegistry（流式中工作区）', read: () => useAgentRegistryStore.getState() },
      { id: 'module', label: 'moduleStore（模块/工作区视图）', read: () => useModuleStore.getState() },
      { id: 'layout', label: 'layoutStore（面板开合/宽度）', read: () => useLayoutStore.getState() },
      { id: 'dock', label: 'dockStore（底部/右侧标签）', read: () => useDockStore.getState() },
      { id: 'theme', label: 'themeStore（主题）', read: () => useThemeStore.getState() },
      { id: 'visual', label: 'visualStore（可视化面板）', read: () => useVisualStore.getState() },
    ],
    [agentCtx],
  );

  const active = sources.find((source) => source.id === activeId) ?? sources[0];
  // 快照是「点刷新那一刻」的副本：store 后面再变也不会自动改写这里，方便对照改动前后。
  const snapshot = useMemo(() => {
    try {
      return summarize(active.read(), { maxDepth: 5, maxItems: 12, maxString: 400 });
    } catch (e) {
      return { '<读取失败>': e instanceof Error ? e.message : String(e) };
    }
    // tick 是显式的刷新信号：点一次重新读一次 store。
  }, [active, tick]);

  const text = useMemo(() => prettyJson(snapshot), [snapshot]);
  const keyCount = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? Object.keys(snapshot).length : null;

  return (
    <div className={styles.root} data-testid="dev-state-tab" style={{ flex: 1, minHeight: 0 }}>
      <div className={styles.toolbar} style={{ flexWrap: 'wrap', gap: 8 }}>
        <select
          className={styles.select}
          value={activeId}
          onChange={(e) => setActiveId(e.target.value)}
          data-testid="dev-state-select"
        >
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.label}
            </option>
          ))}
        </select>
        <button type="button" className={styles.button} onClick={() => setTick((value) => value + 1)}>
          <RefreshCw size={13} />
          刷新快照
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(text)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => undefined);
          }}
        >
          <Copy size={13} />
          {copied ? '已复制' : '复制 JSON'}
        </button>
        <span className={styles.toolbarSpacer} />
        <span className={styles.hint}>
          {keyCount === null ? '' : `${keyCount} 个顶层字段 · `}深度 5 / 数组 12 项，超出会折叠
        </span>
      </div>
      <div className={styles.scroll} style={{ paddingBlockStart: 12 }}>
        {snapshot === null ? (
          <div className={styles.state}>该 store 当前不可用（多半是没有活跃工作区）</div>
        ) : (
          <pre className={styles.rowBody} style={{ maxHeight: 'none' }} data-testid="dev-state-json">
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}
