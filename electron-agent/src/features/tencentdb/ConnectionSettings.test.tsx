import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { config, defaultConfig, save, test, openPanel } = vi.hoisted(() => ({
  config: { mode: 'remote', endpoint: 'https://m', knowledgeEndpoint: 'https://k/v3', serviceId: 'personal-memory', teamId: 'personal-alice', agentId: 'pi-personal', userId: 'alice' },
  defaultConfig: { mode: 'local', endpoint: '', serviceId: 'personal-memory', teamId: 'personal-local', agentId: 'pi-personal', userId: 'local' },
  save: vi.fn(() => Promise.resolve({ mode: 'remote', endpoint: 'https://m', state: 'ready', credentialConfigured: true })),
  test: vi.fn(() => Promise.resolve({ mode: 'remote', endpoint: 'https://m', state: 'ready', credentialConfigured: true })),
  openPanel: vi.fn(() => Promise.resolve({ url: 'http://127.0.0.1:43123/__grenagent/bootstrap#tdai-bootstrap=one-time' })),
}));
const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock('../../platform/runtime', () => ({ openUrl }));
vi.mock('./tencentdbApi', () => ({
  DEFAULT_TENCENTDB_CONFIG: defaultConfig,
  tencentdbApi: { save, test, openPanel },
  useTencentdbConnection: () => ({
    config,
    status: { mode: 'remote', endpoint: 'https://m', state: 'ready', credentialConfigured: true },
    loading: false,
    error: null,
    reload: vi.fn(() => Promise.resolve()),
    setConfig: vi.fn(),
    setStatus: vi.fn(),
  }),
}));

import { ConnectionSettings } from './ConnectionSettings';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ConnectionSettings', () => {
  it('shows a redacted credential state and saves only when a new key is entered', async () => {
    render(<ConnectionSettings />);
    expect(screen.getByText(/已连接/)).toBeTruthy();
    expect(screen.getByTestId('tencentdb-gateway-key')).toBeTruthy();
    const userKey = screen.getByTestId('tencentdb-user-key');
    expect(screen.getByTestId('tencentdb-knowledge-endpoint').getAttribute('required')).not.toBeNull();
    expect(screen.getByTestId('tencentdb-team-id')).not.toBeDisabled();
    expect(screen.getByTestId('tencentdb-agent-id')).not.toBeDisabled();
    expect(screen.getByTestId('tencentdb-user-id')).not.toBeDisabled();
    fireEvent.change(screen.getByTestId('tencentdb-endpoint'), { target: { value: 'https://new-memory' } });
    fireEvent.change(userKey, { target: { value: 'sk-mem-remote-user' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ endpoint: 'https://new-memory' }),
      userApiKey: 'sk-mem-remote-user',
    })));
  });

  it('switches local mode to bundled runtime fields instead of remote endpoints', () => {
    render(<ConnectionSettings />);
    fireEvent.click(screen.getByText('本机 local'));
    expect(screen.queryByTestId('tencentdb-endpoint')).toBeNull();
    expect(screen.queryByTestId('tencentdb-knowledge-endpoint')).toBeNull();
    expect(screen.queryByTestId('tencentdb-llm-model')).toBeNull();
    expect(screen.queryByText('LLM Base URL')).toBeNull();
    expect(screen.queryByText('LLM API Key')).toBeNull();
    expect(screen.getByText(/固定单用户身份/)).toBeTruthy();
    expect(screen.getByTestId('tencentdb-service-id')).not.toBeDisabled();
    expect(screen.getByTestId('tencentdb-team-id')).toHaveValue('personal-local');
    expect(screen.getByTestId('tencentdb-team-id')).toBeDisabled();
    expect(screen.getByTestId('tencentdb-agent-id')).toHaveValue('pi-personal');
    expect(screen.getByTestId('tencentdb-agent-id')).toBeDisabled();
    expect(screen.getByTestId('tencentdb-user-id')).toHaveValue('local');
    expect(screen.getByTestId('tencentdb-user-id')).toBeDisabled();
  });

  it('opens the native panel and prevents duplicate requests while opening', async () => {
    let resolveOpen!: (value: { url: string }) => void;
    openPanel.mockImplementationOnce(() => new Promise((resolve) => { resolveOpen = resolve; }));
    render(<ConnectionSettings />);

    const button = screen.getByRole('button', { name: '打开原生后台' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();

    resolveOpen({ url: 'http://127.0.0.1:43123/__grenagent/bootstrap#tdai-bootstrap=one-time' });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:43123/__grenagent/bootstrap#tdai-bootstrap=one-time');
  });

  it('shows an error when opening the native panel fails', async () => {
    openPanel.mockRejectedValueOnce(new Error('panel unavailable'));
    render(<ConnectionSettings />);

    fireEvent.click(screen.getByRole('button', { name: '打开原生后台' }));
    await waitFor(() => expect(screen.getByText('panel unavailable')).toBeTruthy());
  });
});
