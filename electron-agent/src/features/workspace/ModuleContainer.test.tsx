// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModuleContainer } from './ModuleContainer';
import { useModuleStore } from '../../stores/moduleStore';
import { useSessionStore } from '../../store';

vi.mock('../settings/SettingsPanel', () => ({ SettingsPanel: () => <div>SET_PANEL</div> }));
vi.mock('../connections/ConnectionsPanel', () => ({ ConnectionsPanel: () => <div>CONN_PANEL</div> }));
vi.mock('../extensions/ExtensionsPanel', () => ({ ExtensionsPanel: () => <div>EXT_PANEL</div> }));
vi.mock('../usage/UsagePanel', () => ({ UsagePanel: () => <div>USAGE_PANEL</div> }));
vi.mock('../agentData/AgentDataCenter', () => ({ AgentDataCenter: ({ userId, initialProject }: { userId?: string; initialProject?: string }) => <div>AGENT_DATA:{userId}:{initialProject}</div> }));
// 未打桩的话会渲染真实工作台（依赖 window.gren、zustand store 等），在 jsdom 下会炸。
vi.mock('../devtools/DevWorkbench', () => ({ DevWorkbench: () => <div>DEV_WORKBENCH</div> }));

beforeEach(() => {
  useModuleStore.setState({ activeModule: 'chat' });
  useSessionStore.setState({ activeWorkspace: '/workspace' });
});

afterEach(() => {
  cleanup();
});

describe('ModuleContainer', () => {
  it('renders chat content when chat module is active', () => {
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(screen.getByText('CHAT_CONTENT')).toBeTruthy();
  });

  const cases: [string, string][] = [
    ['settings', 'SET_PANEL'],
    ['connections', 'CONN_PANEL'],
    ['extensions', 'EXT_PANEL'],
    ['usage', 'USAGE_PANEL'],
    ['devWorkbench', 'DEV_WORKBENCH'],
  ];
  for (const [mod, text] of cases) {
    it(`renders ${text} for ${mod} module`, () => {
      useModuleStore.setState({ activeModule: mod as never });
      render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
      expect(screen.getByText(text)).toBeTruthy();
    });
  }

  it('passes the active workspace as the panel initial project', () => {
    useModuleStore.setState({ activeModule: 'agentData' });
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(screen.getByText('AGENT_DATA:local:/workspace')).toBeTruthy();
  });
});
