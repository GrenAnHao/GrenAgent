import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSettings, setSettings, closeWorkspace, openWorkspace, getProviderConfig, setProviderConfig } = vi.hoisted(() => ({
  getSettings: vi.fn(() => Promise.resolve({ OPENAI_API_KEY: 'sk-old', titleModel: 'haiku' })),
  setSettings: vi.fn(() => Promise.resolve()),
  closeWorkspace: vi.fn(() => Promise.resolve()),
  openWorkspace: vi.fn(() => Promise.resolve({})),
  getProviderConfig: vi.fn(() => Promise.resolve({ modelsJson: '{}', authJson: '{}', agentDir: '/a' })),
  setProviderConfig: vi.fn(() => Promise.resolve({ refreshed: [], failed: [] })),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({
  pi: { getSettings, setSettings, closeWorkspace, openWorkspace, getProviderConfig, setProviderConfig },
}));

import { SettingsPanel } from './SettingsPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// 渲染整面板含大量 antd 控件，jsdom 下偏慢，单测放宽超时。
const T = 30000;

describe('SettingsPanel', () => {
  it(
    'renders grouped nav and prefills loaded values',
    async () => {
      render(<SettingsPanel />);
      await waitFor(() => expect(screen.getByTestId('set-cat-general')).toBeTruthy());
      expect(screen.getByTestId('set-cat-knowledge')).toBeTruthy();
      expect(screen.getByTestId('set-cat-memory')).toBeTruthy();
      expect(screen.getByText('能力')).toBeTruthy();
      const input = screen.getByTestId('set-field-titleModel') as HTMLInputElement;
      expect(input.value).toBe('haiku');
    },
    T,
  );

  it(
    'switches category and shows section cards',
    async () => {
      render(<SettingsPanel />);
      await waitFor(() => expect(screen.getByTestId('set-cat-memory')).toBeTruthy());
      fireEvent.click(screen.getByTestId('set-cat-memory'));
      await waitFor(() => expect(screen.getByTestId('set-card-记忆召回')).toBeTruthy());
      expect(screen.getByTestId('set-card-记忆维护')).toBeTruthy();
      expect(screen.getByTestId('set-field-MEMORY_AUTO_INJECT')).toBeTruthy();
    },
    T,
  );

  it(
    'edits a field and saves on button click without restart',
    async () => {
      render(<SettingsPanel />);
      await waitFor(() => expect(screen.getByTestId('set-field-titleModel')).toBeTruthy());
      fireEvent.change(screen.getByTestId('set-field-titleModel'), { target: { value: 'gpt-x' } });
      fireEvent.click(screen.getByTestId('set-save'));
      await waitFor(
        () => expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ titleModel: 'gpt-x' })),
        { timeout: 3000 },
      );
      expect(closeWorkspace).not.toHaveBeenCalled();
    },
    T,
  );
});
