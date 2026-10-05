import { lazy, Suspense, type ComponentType } from 'react';
import type { DockTab, DockTabKind } from '../../stores/dockStore';
import { PageBody } from './PageBody';
import { BrowserBody } from './browser/BrowserBody';
import { FileTreeBody } from './FileTreeBody';
import { ProjectContextBody } from './ProjectContextBody';
import { SubAgentBody } from './SubAgentBody';
import { SubAgentLogBody } from './SubAgentLogBody';
import { TurnReviewBody } from './TurnReviewBody';
import { VisualPanel } from '../visual/VisualPanel';

export interface DockBodyProps {
  tab: DockTab;
  active: boolean;
}

function VisualDockBody(_props: DockBodyProps) {
  return <VisualPanel />;
}

// xterm 只有打开终端标签才用得到，不进首包。
const LazyTerminalBody = lazy(() => import('./TerminalBody').then((m) => ({ default: m.TerminalBody })));

function TerminalDockBody(props: DockBodyProps) {
  return (
    <Suspense fallback={null}>
      <LazyTerminalBody {...props} />
    </Suspense>
  );
}

const BODY_RENDERERS: Record<DockTabKind, ComponentType<DockBodyProps>> = {
  terminal: TerminalDockBody,
  browser: BrowserBody,
  page: PageBody,
  subagent: SubAgentBody,
  subagentLog: SubAgentLogBody,
  projectContext: ProjectContextBody,
  file: FileTreeBody,
  review: TurnReviewBody,
  visual: VisualDockBody,
};

export function TabBodyRenderer({ tab, active }: DockBodyProps) {
  const Body = BODY_RENDERERS[tab.kind];
  return <Body tab={tab} active={active} />;
}
