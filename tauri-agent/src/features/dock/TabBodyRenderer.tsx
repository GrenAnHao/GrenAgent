import type { ComponentType } from 'react';
import type { DockTab, DockTabKind } from '../../stores/dockStore';
import { PageBody } from './PageBody';
import { SubAgentBody } from './SubAgentBody';
import { TerminalBody } from './TerminalBody';

export interface DockBodyProps {
  tab: DockTab;
  active: boolean;
}

const BODY_RENDERERS: Record<DockTabKind, ComponentType<DockBodyProps>> = {
  terminal: TerminalBody,
  page: PageBody,
  subagent: SubAgentBody,
  // file: FileBody,        // 阶段 2
  // diff: DiffBody,        // 阶段 3
  // sidechat: SideChatBody // 阶段 4
};

export function TabBodyRenderer({ tab, active }: DockBodyProps) {
  const Body = BODY_RENDERERS[tab.kind];
  return <Body tab={tab} active={active} />;
}
