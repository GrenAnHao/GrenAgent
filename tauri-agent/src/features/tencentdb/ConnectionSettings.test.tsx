import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { config, defaultConfig, save, test } = vi.hoisted(() => ({
  config: { mode: 'remote', endpoint: 'https://m', knowledgeEndpoint: 'https://k/v3', serviceId: 'personal-memory', teamId: 'personal-alice', agentId: 'pi-personal', userId: 'alice' },
  defaultConfig: { mode: 'local', endpoint: '', serviceId: 'personal-memory', teamId: 'personal-local', agentId: 'pi-personal', userId: 'local' },
  save: vi.fn(() => Promise.resolve({ mode: 'remote', endpoint: 'https://m', state: 'ready', credentialConfigured: true })),
  test: vi.fn(() => Promise.resolve({ mode: 'remote', endpoint: 'https://m', state: 'ready', credentialConfigured: true })),
}));
vi.mock('./tencentdbApi', () => ({
  DEFAULT_TENCENTDB_CONFIG: defaultConfig,
  tencentdbApi: { save, test },
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
    expect(screen.getByTestId('tencentdb-llm-model')).toBeTruthy();
    expect(screen.getByText(/固定单用户身份/)).toBeTruthy();
    expect(screen.getByTestId('tencentdb-service-id')).not.toBeDisabled();
    expect(screen.getByTestId('tencentdb-team-id')).toHaveValue('personal-local');
    expect(screen.getByTestId('tencentdb-team-id')).toBeDisabled();
    expect(screen.getByTestId('tencentdb-agent-id')).toHaveValue('pi-personal');
    expect(screen.getByTestId('tencentdb-agent-id')).toBeDisabled();
    expect(screen.getByTestId('tencentdb-user-id')).toHaveValue('local');
    expect(screen.getByTestId('tencentdb-user-id')).toBeDisabled();
  });
});
