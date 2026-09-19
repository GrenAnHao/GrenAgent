import type { LucideIcon } from 'lucide-react';
import { Bot, Folder, FolderTree, GitPullRequest, Globe, SquareTerminal } from 'lucide-react';
import type { DockTabKind } from '../../stores/dockStore';
import type { LauncherKind } from './launcherItems';

const LAUNCHER_ICONS: Record<LauncherKind, LucideIcon> = {
  review: GitPullRequest,
  terminal: SquareTerminal,
  browser: Globe,
  file: FolderTree,
};

export function launcherKindIcon(kind: LauncherKind): LucideIcon {
  return LAUNCHER_ICONS[kind];
}

export function dockTabKindIcon(kind: DockTabKind): LucideIcon {
  switch (kind) {
    case 'browser':
    case 'page':
      return Globe;
    case 'terminal':
      return SquareTerminal;
    case 'review':
      return GitPullRequest;
    case 'file':
      return FolderTree;
    case 'projectContext':
      return Folder;
    case 'subagent':
    case 'subagentLog':
      return Bot;
  }
}
