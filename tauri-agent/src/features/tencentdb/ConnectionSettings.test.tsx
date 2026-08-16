import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { config, save, test } = vi.hoisted(() => ({
  config: { mode: 'remote', endpoint: 'https://m', serviceId: 'personal-memory', teamId: 'personal:alice', agentId: 'pi-personal', userId: 'alice' },
  save: vi.fn(() => Promise.resolve({ mode: 'remote', endpoint: 'https://m', state: 'ready', credentialConfigured: true })),
  test: vi.fn(() => Promise.resolve({ mode: 'remote', endpoint: 'https://m', state: 'ready', credentialConfigured: true })),
}));
vi.mock('./tencentdbApi', () => ({
  DEFAULT_TENCENTDB_CONFIG: config,
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
    expect(screen.getByPlaceholderText('已配置，输入新值可替换')).toBeTruthy();
    fireEvent.change(screen.getByTestId('tencentdb-endpoint'), { target: { value: 'https://new-memory' } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ endpoint: 'https://new-memory' }) })));
  });
});
