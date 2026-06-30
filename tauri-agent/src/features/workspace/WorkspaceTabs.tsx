import { memo } from 'react';
import { Library, type LucideIcon, MessageSquare } from 'lucide-react';
import { useModuleStore, type WorkspaceView } from '../../stores/moduleStore';

interface TabDef {
  id: WorkspaceView;
  label: string;
  Icon: LucideIcon;
}

/** 主列内的工作区视图 tab：项目级面板（绑定当前工作区），侧栏常驻、上下文不丢。 */
const TABS: TabDef[] = [
  { id: 'chat', label: '对话', Icon: MessageSquare },
  { id: 'knowledge', label: '知识库', Icon: Library },
];

export const WorkspaceTabs = memo(function WorkspaceTabs() {
  const activeView = useModuleStore((s) => s.activeWorkspaceView);
  const setActiveWorkspaceView = useModuleStore((s) => s.setActiveWorkspaceView);

  return (
    <div data-testid="workspace-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {TABS.map(({ id, label, Icon }) => {
        const active = activeView === id;
        return (
          <button
            key={id}
            data-testid={`workspace-tab-${id}`}
            aria-pressed={active}
            title={label}
            onClick={() => setActiveWorkspaceView(id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              height: 28,
              padding: '0 10px',
              border: 'none',
              borderRadius: 7,
              cursor: 'pointer',
              fontSize: 12,
              whiteSpace: 'nowrap',
              background: active ? 'var(--gren-rail-active, rgba(255,255,255,0.08))' : 'transparent',
              color: active ? 'var(--gren-fg, inherit)' : 'var(--gren-fg-muted, #9aa1ac)',
            }}
          >
            <Icon size={15} />
            {label}
          </button>
        );
      })}
    </div>
  );
});
