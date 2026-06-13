import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSettings, setSettings, closeWorkspace, openWorkspace } = vi.hoisted(() => ({
  getSettings: vi.fn((): Promise<Record<string, string>> => Promise.resolve({ IM_GATEWAY: '0', IM_GATEWAY_PORT: '8765' })),
  setSettings: vi.fn(() => Promise.resolve()),
  closeWorkspace: vi.fn(() => Promise.resolve()),
  openWorkspace: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({
  pi: { getSettings, setSettings, closeWorkspace, openWorkspace },
}));

import { ConnectionsPanel } from './ConnectionsPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ConnectionsPanel', () => {
  it('renders gateway fields prefilled', async () => {
    render(<ConnectionsPanel />);
    await waitFor(() => expect(screen.getByTestId('conn-field-IM_GATEWAY_PORT')).toBeTruthy());
    expect((screen.getByTestId('conn-field-IM_GATEWAY_PORT') as HTMLInputElement).value).toBe('8765');
    expect(screen.getByText('Slack')).toBeTruthy();
  });

  it('saves gateway config', async () => {
    render(<ConnectionsPanel />);
    await waitFor(() => expect(screen.getByTestId('conn-field-IM_GATEWAY_PORT')).toBeTruthy());
    fireEvent.change(screen.getByTestId('conn-field-IM_GATEWAY_PORT'), { target: { value: '9000' } });
    fireEvent.click(screen.getByTestId('conn-save'));
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ IM_GATEWAY_PORT: '9000' })),
    );
  });

});
