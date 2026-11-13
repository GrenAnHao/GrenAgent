// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModuleContainer } from './ModuleContainer';
import { useModuleStore } from '../../stores/moduleStore';
import { useSessionStore } from '../../store';

vi.mock('../settings/SettingsPanel', () => ({ SettingsPanel: () => <div>SET_PANEL</div> }));
vi.mock('../connections/ConnectionsPanel', () => ({ ConnectionsPanel: () => <div>CONN_PANEL</div> }));
vi.mock('../extensions/ExtensionsPanel', () => ({ ExtensionsPanel: () => <div>EXT_PANEL</div> }));
vi.mock('../usage/UsagePanel', () => ({ UsagePanel: () => <div>USAGE_PANEL</div> }));
vi.mock('../codeIndex/CodeIndexWorkspace', () => ({ CodeIndexWorkspace: ({ initialProject }: { initialProject?: string }) => <div data-testid="code-index-content">CODE_INDEX:{initialProject}</div> }));
// 开发工作台未打桩时会渲染真实组件（依赖 window.gren 等），jsdom 下会炸。
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
    it(`renders ${text} for ${mod} module`, async () => {
      useModuleStore.setState({ activeModule: mod as never });
      render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
      expect(await screen.findByText(text)).toBeTruthy();
    });
  }

  it('mounts the code index module independently, with the active workspace', async () => {
    useModuleStore.setState({ activeModule: 'codeIndex' });
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(await screen.findByText('CODE_INDEX:/workspace')).toBeTruthy();
  });

  it('normalises a retired Agent Data module back to chat', async () => {
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    act(() => useModuleStore.getState().setActiveModule('agentData'));
    expect(useModuleStore.getState().activeModule).toBe('chat');
    expect(screen.getByText('CHAT_CONTENT')).toBeTruthy();
    expect(screen.queryByTestId('agent-data-content')).toBeNull();
  });
});
