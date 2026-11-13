import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { models, piMock } = vi.hoisted(() => ({
  models: [{ provider: 'one', id: 'same', name: 'One Model' }, { provider: 'two', id: 'same', name: 'Two Model' }],
  piMock: { getState: vi.fn(), setModel: vi.fn(), setThinkingLevel: vi.fn() },
}));
vi.mock('../../../../lib/pi', () => ({ pi: piMock }));
vi.mock('../../../../stores/AgentStoreContext', () => ({ useAgentStoreContext: () => ({ workspace: '/legacy', workspaceReady: true }) }));
vi.mock('../../../settings/availableModelsCache', () => ({
  useAvailableModelsState: () => ({ models, loading: false }),
  getCachedAvailableModels: () => models,
  loadAvailableModels: async () => models,
}));
vi.mock('../../../settings/providerListCache', () => ({ loadProviderList: async () => [] }));
import { MODEL_VISIBILITY_STORAGE_KEY, useModelVisibilityStore } from '../../../../stores/modelVisibilityStore';
import ModelAction from './ModelAction';

beforeEach(() => {
  localStorage.removeItem(MODEL_VISIBILITY_STORAGE_KEY);
  useModelVisibilityStore.setState({ hidden: [] });
  vi.clearAllMocks();
  piMock.getState.mockResolvedValue({ model: { provider: 'one', id: 'same' } });
});
afterEach(cleanup);

it('does not let the real Select reinsert a hidden current value into its popup', async () => {
  render(<ModelAction />);
  const trigger = await screen.findByRole('combobox');
  await waitFor(() => expect(trigger.textContent).toContain('One Model'));
  act(() => useModelVisibilityStore.getState().setHidden('one', 'same', true));
  fireEvent.click(trigger);
  await screen.findByRole('option', { name: 'Two Model' });
  expect(screen.getAllByRole('option')).toHaveLength(1);
  expect(screen.queryByRole('option', { name: /One Model|one/ })).toBeNull();
  expect(trigger.textContent).toContain('One Model');
  fireEvent.keyDown(trigger, { key: 'Escape' });
  act(() => useModelVisibilityStore.getState().setHidden('two', 'same', true));
  expect(trigger).toBeDisabled();
  expect(trigger.textContent).toContain('One Model');
  expect(piMock.setModel).not.toHaveBeenCalled();
  expect(piMock.setThinkingLevel).not.toHaveBeenCalled();
  expect(models).toHaveLength(2);
});
