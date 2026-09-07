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
vi.mock('../agentData/AgentDataCenter', () => ({
  AgentDataCenter: ({ userId, initialProject, visible = true, onOpenSession }: { userId?: string; initialProject?: string; visible?: boolean; onOpenSession?: (cwd: string, path: string) => void }) => <div data-testid="agent-data-content" data-visible={visible}>
    <span>AGENT_DATA:{userId}:{initialProject}</span>
    <input aria-label="Agent 数据搜索" defaultValue="" />
    <button onClick={() => onOpenSession?.('/source-project', '/actual/sessions/source.jsonl')}>打开来源会话</button>
  </div>,
}));
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
  it('forwards an existing source session without substituting the current chat project', () => {
    useModuleStore.setState({ activeModule: 'agentData' });
    const onOpenSession = vi.fn();
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByRole('button', { name: '打开来源会话' }));
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith('/source-project', '/actual/sessions/source.jsonl');
  });

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

  it('does not mount Agent Data before its first visit', () => {
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(screen.queryByTestId('agent-data-content')).toBeNull();
    act(() => useModuleStore.setState({ activeModule: 'settings' }));
    expect(screen.queryByTestId('agent-data-content')).toBeNull();
  });

  it('retains Agent Data input, scroll and nodes across module switches', () => {
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    const chat = screen.getByText('CHAT_CONTENT');
    act(() => useModuleStore.setState({ activeModule: 'agentData' }));
    const content = screen.getByTestId('agent-data-content');
    const input = screen.getByLabelText('Agent 数据搜索') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'retained query' } });
    content.scrollTop = 128;

    act(() => useModuleStore.setState({ activeModule: 'chat' }));
    expect(screen.getByTestId('agent-data-content')).toBe(content);
    expect(content.dataset.visible).toBe('false');
    expect(content.parentElement?.hidden).toBe(true);
    expect(screen.getByText('CHAT_CONTENT')).toBe(chat);

    act(() => useModuleStore.setState({ activeModule: 'agentData' }));
    expect(screen.getByLabelText('Agent 数据搜索')).toBe(input);
    expect(input.value).toBe('retained query');
    expect(screen.getByTestId('agent-data-content')).toBe(content);
    expect(content.scrollTop).toBe(128);
    expect(content.dataset.visible).toBe('true');
    expect(content.parentElement?.hidden).toBe(false);
    expect(screen.getByText('CHAT_CONTENT')).toBe(chat);
  });

  it('snapshots the workspace on the first Agent Data visit', () => {
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    act(() => useSessionStore.setState({ activeWorkspace: '/before-open' }));
    act(() => useModuleStore.setState({ activeModule: 'agentData' }));
    expect(screen.getByText('AGENT_DATA:local:/before-open')).toBeTruthy();

    act(() => useModuleStore.setState({ activeModule: 'chat' }));
    act(() => useSessionStore.setState({ activeWorkspace: '/later-project' }));
    act(() => useModuleStore.setState({ activeModule: 'agentData' }));
    expect(screen.getByText('AGENT_DATA:local:/before-open')).toBeTruthy();
  });
});
