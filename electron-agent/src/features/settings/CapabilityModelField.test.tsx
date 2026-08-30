import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingField } from './settingsSchema';

const { getProviderConfig } = vi.hoisted(() => ({
  getProviderConfig: vi.fn(() =>
    Promise.resolve({ modelsJson: '{}', authJson: '{"openai":{"type":"api_key","key":"k"}}', agentDir: '/a' }),
  ),
}));
vi.mock('../../lib/pi', () => ({ pi: { getProviderConfig } }));

import { CapabilityModelField } from './CapabilityModelField';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const field: SettingField = {
  key: 'IMAGE_PROVIDER',
  modelKey: 'IMAGE_MODEL',
  capability: 'image',
  label: '图像模型',
  type: 'capability',
};

describe('CapabilityModelField', () => {
  it('renders label and current model value after loading providers', async () => {
    render(
      <CapabilityModelField
        field={field}
        values={{ IMAGE_PROVIDER: 'openai', IMAGE_MODEL: 'gpt-image-1' }}
        setValue={() => {}}
      />,
    );
    await waitFor(() => expect(getProviderConfig).toHaveBeenCalled());
    expect(screen.getByText('图像模型')).toBeTruthy();
    // 改为下拉后，当前值以选中项文本展示（而非 input 的 value）。
    expect(screen.getByText('gpt-image-1')).toBeTruthy();
  });
});
