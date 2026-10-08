// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted 保证 mock 工厂在模块导入阶段就能拿到这些 spy（vi.mock 会被提升到 import 之前）。
const mocks = vi.hoisted(() => ({
  devInfo: vi.fn(),
  devCommands: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('../../lib/devRuntime', () => ({
  devApi: {
    info: () => mocks.devInfo(),
    commands: () => mocks.devCommands(),
  },
}));
vi.mock('../../platform/runtime', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
  listen: async (channel: string) => {
    mocks.listen(channel);
    return () => {};
  },
  openPath: async () => {},
}));

import { DevWorkbench } from './DevWorkbench';
import { useSessionStore } from '../../store';

const RUNTIME_INFO = {
  appName: 'electron-agent',
  appVersion: '0.1.0',
  isPackaged: false,
  electron: '38.0.0',
  chrome: '140.0.0',
  node: '22.0.0',
  v8: '14.0.0',
  platform: 'win32',
  arch: 'x64',
  locale: 'zh-CN',
  pid: 4242,
  uptimeSec: 12,
  windowCount: 1,
  paths: { appPath: '/app', userData: '/user-data', logs: '/logs', temp: '/tmp', home: '/home', cwd: '/app' },
  memory: { rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 },
  env: { nodeEnv: 'development', rendererUrl: 'http://localhost:5173', piAgentDir: null },
};

beforeEach(() => {
  useSessionStore.setState({ activeWorkspace: '/tmp/project', activeSessionPath: null, worksDir: '', sessions: [], allSessions: [] });
  mocks.devInfo.mockReset().mockResolvedValue(RUNTIME_INFO);
  mocks.devCommands.mockReset().mockResolvedValue(['dev_runtime_info', 'dev_list_commands', 'get_settings']);
  mocks.invoke.mockReset().mockResolvedValue({ ok: true });
  mocks.listen.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('DevWorkbench', () => {
  it('renders the four tool tabs with runtime as the default', () => {
    render(<DevWorkbench />);
    expect(screen.getByTestId('dev-workbench')).toBeTruthy();
    for (const id of ['runtime', 'ipc', 'events', 'state']) {
      expect(screen.getByTestId(`dev-tab-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId('dev-runtime-tab')).toBeTruthy();
  });

  it('shows main-process runtime info once loaded', async () => {
    render(<DevWorkbench />);
    expect(await screen.findByText('38.0.0 / 140.0.0')).toBeTruthy();
    expect(screen.getByText('/user-data')).toBeTruthy();
  });

  it('surfaces the error when the main process does not expose dev commands', async () => {
    mocks.devInfo.mockRejectedValue(new Error('Electron command is not registered: dev_runtime_info'));
    render(<DevWorkbench />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('dev_runtime_info');
  });

  it('switches to the IPC playground and runs a command', async () => {
    render(<DevWorkbench />);
    fireEvent.click(screen.getByTestId('dev-tab-ipc'));
    expect(screen.getByTestId('dev-ipc-tab')).toBeTruthy();
    // 命令清单在挂载时拉取一次，供下拉补全与计数使用。
    expect(await screen.findByText('已注册 3 个')).toBeTruthy();

    fireEvent.click(screen.getByText('执行'));
    expect(mocks.invoke).toHaveBeenCalledWith('dev_runtime_info', {});
    expect(await screen.findByTestId('dev-ipc-result')).toBeTruthy();
  });

  it('rejects malformed arguments without calling the backend', () => {
    render(<DevWorkbench />);
    fireEvent.click(screen.getByTestId('dev-tab-ipc'));
    fireEvent.change(screen.getByTestId('dev-ipc-args'), { target: { value: '[1,2]' } });
    fireEvent.click(screen.getByText('执行'));
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('参数不是合法 JSON 对象');
  });

  it('subscribes only to pi://event by default and adds channels when checked', () => {
    render(<DevWorkbench />);
    fireEvent.click(screen.getByTestId('dev-tab-events'));
    expect(screen.getByTestId('dev-events-tab')).toBeTruthy();
    expect(mocks.listen.mock.calls).toEqual([['pi://event']]);

    mocks.listen.mockClear();
    fireEvent.click(screen.getByText('pi://ui-request'));
    expect(mocks.listen.mock.calls.map(([channel]) => channel).sort()).toEqual(['pi://event', 'pi://ui-request']);
  });

  it('renders a store snapshot on the state tab', () => {
    render(<DevWorkbench />);
    fireEvent.click(screen.getByTestId('dev-tab-state'));
    expect(screen.getByTestId('dev-state-json').textContent).toContain('activeWorkspace');
  });
});
