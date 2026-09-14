import { Icon } from '@lobehub/ui';
import { useDroppable } from '@dnd-kit/core';
import type { LucideIcon } from 'lucide-react';
import { FolderTree, GitPullRequest, Globe, SquareTerminal } from 'lucide-react';
import { useSessionStore } from '../../store/session';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import type { DockRegion } from '../../stores/dockStore';
import { dockTabStyles } from './dockTabStyles';
import { launcherItems, type LauncherKind } from './launcherItems';
import { openLauncherTab } from './openLauncherTab';

const ICONS: Record<LauncherKind, LucideIcon> = {
  review: GitPullRequest,
  terminal: SquareTerminal,
  browser: Globe,
  file: FolderTree,
};

interface DockLauncherProps {
  region: DockRegion;
}

export function DockLauncher({ region }: DockLauncherProps) {
  const { workspace } = useAgentStoreContext();
  const worksDir = useSessionStore((s) => s.worksDir);
  const items = launcherItems({ cwd: workspace, worksDir, workspace });
  const { setNodeRef } = useDroppable({ id: `dock:${region}` });

  return (
    <div ref={setNodeRef} className={dockTabStyles.launcher} data-testid={`dock-launcher-${region}`}>
      {items.map((item) => (
        <button
          key={item.kind}
          type="button"
          className={dockTabStyles.launcherRow}
          disabled={item.disabled}
          data-testid={`dock-launcher-${item.kind}`}
          onClick={() => openLauncherTab({ region, kind: item.kind, workspace })}
        >
          <Icon icon={ICONS[item.kind]} size={14} />
          <span>{item.label}</span>
          <span className={dockTabStyles.launcherShortcut}>{item.shortcut}</span>
        </button>
      ))}
    </div>
  );
}
