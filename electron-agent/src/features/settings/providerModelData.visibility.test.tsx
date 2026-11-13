import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { raw } = vi.hoisted(() => ({ raw: [
  { provider: 'openai', id: 'gpt-image-1', name: 'Image One' },
  { provider: 'other', id: 'gpt-image-1', name: 'Other Image' },
] }));
vi.mock('./availableModelsCache', () => ({ useAvailableModels: () => raw }));
vi.mock('./providerListCache', () => ({ useProviderList: () => [{ id: 'openai', name: 'OpenAI' }, { id: 'other', name: 'Other' }] }));
import { useModelVisibilityStore, MODEL_VISIBILITY_STORAGE_KEY } from '../../stores/modelVisibilityStore';
import { useProviderModelData } from './providerModelData';
import { ModelSelectField } from './ModelSelectField';
import { ModelListField } from './ModelListField';
import { CapabilityModelField } from './CapabilityModelField';

beforeEach(() => {
  localStorage.removeItem(MODEL_VISIBILITY_STORAGE_KEY);
  useModelVisibilityStore.setState({ hidden: [] });
});
afterEach(cleanup);

async function optionTitles(testId: string) {
  fireEvent.mouseDown(screen.getByTestId(testId).closest('.ant-select')!);
  return waitFor(() => {
    const dropdown = document.querySelector('.ant-select-dropdown');
    expect(dropdown).not.toBeNull();
    return Array.from(dropdown!.querySelectorAll('.ant-select-item-option')).map((el) => el.getAttribute('title'));
  });
}

describe('manual settings model projections', () => {
  it('retains raw readiness when every model is hidden and does not offer free typing', () => {
    const { result } = renderHook(() => useProviderModelData());
    act(() => {
      useModelVisibilityStore.getState().setHidden('openai', 'gpt-image-1', true);
      useModelVisibilityStore.getState().setHidden('other', 'gpt-image-1', true);
    });
    expect(result.current.ready).toBe(true);
    expect(result.current.providerOptions).toEqual([]);
    expect(result.current.modelsFor('openai')).toEqual([]);
    render(<ModelSelectField value="openai/gpt-image-1" testId="single" onChange={() => {}} />);
    expect(screen.getByTestId('single').closest('.ant-select')).not.toBeNull();
    expect(raw).toHaveLength(2);
  });

  it('keeps a hidden current single value visible but never reinserts it as a selectable option', async () => {
    useModelVisibilityStore.getState().setHidden('openai', 'gpt-image-1', true);
    const onChange = vi.fn();
    render(<ModelSelectField value="openai/gpt-image-1" testId="single" onChange={onChange} />);
    expect(screen.getByTestId('single').textContent).toContain('gpt-image-1');
    expect(await optionTitles('single')).not.toContain('gpt-image-1');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('retains hidden saved routes as removable labels, not options; same-id other provider stays selectable', async () => {
    useModelVisibilityStore.getState().setHidden('openai', 'gpt-image-1', true);
    const onChange = vi.fn();
    render(<ModelListField value='["openai/gpt-image-1"]' testId="routes" onChange={onChange} />);
    expect(screen.getByTestId('routes').textContent).toContain('gpt-image-1');
    const options = await optionTitles('routes');
    expect(options).not.toContain('openai/gpt-image-1（不可用）');
    expect(options).toEqual(['Other / Other Image']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('filters capability presets after merging, even when the hidden current value is a preset', async () => {
    useModelVisibilityStore.getState().setHidden('openai', 'gpt-image-1', true);
    const setValue = vi.fn();
    render(<CapabilityModelField field={{ key: 'IMAGE_PROVIDER', modelKey: 'IMAGE_MODEL', type: 'capability', capability: 'image', label: 'Image' }} values={{ IMAGE_PROVIDER: 'openai', IMAGE_MODEL: 'gpt-image-1' }} setValue={setValue} />);
    expect(screen.getByTestId('set-field-IMAGE_MODEL').textContent).toContain('gpt-image-1');
    expect(await optionTitles('set-field-IMAGE_MODEL')).not.toContain('gpt-image-1');
    expect(setValue).not.toHaveBeenCalled();
  });
});
