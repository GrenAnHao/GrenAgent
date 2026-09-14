import type { ComponentType } from 'react';
import type { DockTab, DockTabKind } from '../../stores/dockStore';
import { PageBody } from './PageBody';
import { BrowserBody } from './BrowserBody';
import { FileTreeBody } from './FileTreeBody';
import { ProjectContextBody } from './ProjectContextBody';
import { ReviewPlaceholderBody } from './ReviewPlaceholderBody';
import { SubAgentBody } from './SubAgentBody';
import { SubAgentLogBody } from './SubAgentLogBody';
import { TerminalBody } from './TerminalBody';

export interface DockBodyProps {
  tab: DockTab;
  active: boolean;
}

const BODY_RENDERERS: Record<DockTabKind, ComponentType<DockBodyProps>> = {
  terminal: TerminalBody,
  browser: BrowserBody,
  page: PageBody,
  subagent: SubAgentBody,
  subagentLog: SubAgentLogBody,
  projectContext: ProjectContextBody,
  file: FileTreeBody,
  review: ReviewPlaceholderBody,
};

export function TabBodyRenderer({ tab, active }: DockBodyProps) {
  const Body = BODY_RENDERERS[tab.kind];
  return <Body tab={tab} active={active} />;
}
