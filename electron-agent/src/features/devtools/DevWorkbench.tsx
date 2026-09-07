import { useState } from 'react';
import { Cpu, Database, Radio, Terminal } from 'lucide-react';
import { useSessionStore } from '../../store';
import { styles } from './devtoolsStyles';
import { RuntimeTab } from './RuntimeTab';
import { IpcPlaygroundTab } from './IpcPlaygroundTab';
import { EventStreamTab } from './EventStreamTab';
import { StateTab } from './StateTab';

type Tab = 'runtime' | 'ipc' | 'events' | 'state';

const TABS: Array<{ id: Tab; label: string; Icon: typeof Cpu }> = [
  { id: 'runtime', label: '运行时', Icon: Cpu },
  { id: 'ipc', label: 'IPC 调试台', Icon: Terminal },
  { id: 'events', label: '事件流', Icon: Radio },
  { id: 'state', label: '状态快照', Icon: Database },
];

/**
 * 开发者工作台（仅 DEV 构建可达）。
 *
 * 入口有两处：左侧 ModuleRail 的按钮（moduleStore 的 'devWorkbench' 模块，生产构建下不渲染），
 * 以及 App.tsx 里注册的 Ctrl/Cmd + Shift + D。
 */
export function DevWorkbench() {
  const [tab, setTab] = useState<Tab>('runtime');
  const workspace = useSessionStore((s) => s.activeWorkspace);

  return (
    <section className={styles.root} data-testid="dev-workbench">
      <header className={styles.header}>
        <div className={styles.identity}>
          <span className={styles.icon}>
            <Terminal size={18} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className={styles.title}>开发者工作台</div>
            <div className={styles.subtitle}>{workspace || '未绑定工作区'}</div>
          </div>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.badge}>DEV ONLY</span>
        </div>
      </header>

      <nav className={styles.nav} aria-label="开发者工作台">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            data-testid={`dev-tab-${id}`}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={`${styles.tab} ${tab === id ? styles.tabActive : ''}`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </nav>

      <div className={styles.body}>
        {tab === 'runtime' ? <RuntimeTab workspace={workspace} /> : null}
        {tab === 'ipc' ? <IpcPlaygroundTab workspace={workspace} /> : null}
        {tab === 'events' ? <EventStreamTab /> : null}
        {tab === 'state' ? <StateTab /> : null}
      </div>
    </section>
  );
}
