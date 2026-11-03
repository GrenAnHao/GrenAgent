import { memo } from 'react';
import { type LucideIcon, MessageSquare } from 'lucide-react';
import { useModuleStore, type WorkspaceView } from '../../stores/moduleStore';
import { useSessionStore } from '../../store/session';
import { useOptionalAgentStoreContext } from '../../stores/AgentStoreContext';
import { useComposerSessionPath } from '../chat/input/composerOwner';
import { mergeAllSessions } from '../../lib/mergeSessions';
import { pathsEquivalent } from '../../lib/pathUtils';
import { friendlyTime } from '../sessions/useConversations';

interface TabDef {
  id: WorkspaceView;
  Icon: LucideIcon;
}

/** 主列内的工作区视图 tab：项目级面板（绑定当前工作区），侧栏常驻、上下文不丢。 */
const TABS: TabDef[] = [
  { id: 'chat', Icon: MessageSquare },
];

export const WorkspaceTabs = memo(function WorkspaceTabs() {
  const activeView = useModuleStore((s) => s.activeWorkspaceView);
  const setActiveWorkspaceView = useModuleStore((s) => s.setActiveWorkspaceView);
  const context = useOptionalAgentStoreContext();
  const activeWorkspace = useSessionStore((s) => s.activeWorkspace);
  const sessionPath = useComposerSessionPath(context?.workspace ?? activeWorkspace);
  const label = useSessionStore((s) => {
    const session = sessionPath
      ? mergeAllSessions(s.allSessions, s.optimisticSessions).find((item) => pathsEquivalent(item.path, sessionPath))
      : undefined;
    return session?.name || friendlyTime(session?.timestamp ?? null);
  });

  return (
    <div data-testid="workspace-tabs" style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, maxWidth: '100%' }}>
      {TABS.map(({ id, Icon }) => {
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
              minWidth: 0,
              maxWidth: '100%',
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
            <Icon size={15} style={{ flexShrink: 0 }} />
            <span data-testid="workspace-tab-title" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          </button>
        );
      })}
    </div>
  );
});
