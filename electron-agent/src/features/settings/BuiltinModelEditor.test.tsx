import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MODEL_VISIBILITY_STORAGE_KEY, useModelVisibilityStore } from '../../stores/modelVisibilityStore';
import { pi, type BuiltinModelInfo } from '../../lib/pi';
import { BuiltinModelEditor } from './BuiltinModelEditor';

vi.mock('../../lib/pi', () => ({ pi: { listBuiltinModels: vi.fn() } }));
import { builtinModelDraft, patchBuiltinModel, type BuiltinOverride } from './builtinModelOverrides';
import { ProviderModelCard } from './ProviderModelCard';
import { serializeState, type UiModel } from './providerConfigAdapter';

beforeEach(() => {
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value); },
    removeItem: (key: string) => { memory.delete(key); },
    clear: () => memory.clear(),
    key: (index: number) => [...memory.keys()][index] ?? null,
    get length() { return memory.size; },
  });
  useModelVisibilityStore.setState({ hidden: [] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const fixture: BuiltinModelInfo = { id: 'm', api: 'openai-completions', name: 'SDK name', reasoning: true,
  input: ['text'], contextWindow: 100000, maxTokens: 4000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  thinkingLevelMap: { high: 'vendor-high' }, compat: { supportsStrictMode: true, supportsDeveloperRole: true } };

async function mountEditor() {
  vi.mocked(pi.listBuiltinModels).mockResolvedValue([fixture]);
  function Harness() {
    const [overrides, setOverrides] = useState<Record<string, BuiltinOverride>>({});
    return <><BuiltinModelEditor provider={{ id: 'openai', name: 'OpenAI', builtIn: true, models: [], modelOverrides: overrides }} onChange={setOverrides} />
      <output data-testid="saved">{JSON.stringify(overrides)}</output></>;
  }
  render(<Harness />);
  fireEvent.click(await screen.findByTestId('prov-model-expand-builtin-m'));
}

it('renders every built-in model as an independently expandable card without a model selector', async () => {
  vi.mocked(pi.listBuiltinModels).mockResolvedValue([fixture, { ...fixture, id: 'm/other', name: 'Second' }]);
  function Harness() {
    const [overrides, setOverrides] = useState<Record<string, BuiltinOverride>>({});
    return <><BuiltinModelEditor provider={{ id: 'openai', name: 'OpenAI', builtIn: true, models: [], modelOverrides: overrides }} onChange={setOverrides} />
      <output data-testid="saved">{JSON.stringify(overrides)}</output></>;
  }
  render(<Harness />);
  await waitFor(() => expect(screen.getAllByTestId(/^prov-model-id-builtin/).length).toBeGreaterThan(0));
  expect(screen.getAllByTestId(/^prov-model-id-builtin/).map((input) => (input as HTMLInputElement).value)).toEqual(['m', 'm/other']);
  expect(screen.queryByTestId('prov-builtin-select')).toBeNull();
  fireEvent.click(screen.getByTestId('prov-model-expand-builtin-m'));
  expect(screen.queryByTestId('prov-model-body-builtin-m%2Fother')).toBeNull();
  fireEvent.click(screen.getByTestId('prov-model-expand-builtin-m%2Fother'));
  fireEvent.change(screen.getByTestId('prov-model-name-builtin-m'), { target: { value: 'First edited' } });
  fireEvent.change(screen.getByTestId('prov-model-name-builtin-m%2Fother'), { target: { value: 'Second edited' } });
  expect(JSON.parse(screen.getByTestId('saved').textContent!)).toEqual({ m: { name: 'First edited' }, 'm/other': { name: 'Second edited' } });
  fireEvent.click(screen.getByTestId('prov-builtin-reset-m'));
  expect((screen.getByTestId('prov-model-name-builtin-m') as HTMLInputElement).value).toBe('SDK name');
  expect((screen.getByTestId('prov-model-name-builtin-m%2Fother') as HTMLInputElement).value).toBe('Second edited');
  expect(screen.queryByTestId('prov-model-body-builtin-m%2Fother')).not.toBeNull();
});

it('keeps row actions inside the card and offers reset only after a parameter edit', async () => {
  await mountEditor();
  const visibility = screen.getByTestId('prov-builtin-visibility-m');
  expect(visibility.closest('[data-testid="prov-model-card-builtin-m"]')).not.toBeNull();
  expect(visibility.getAttribute('aria-label')).toBe('隐藏模型');
  expect(screen.queryByTestId('prov-builtin-status-m')).toBeNull();
  expect(screen.queryByTestId('prov-builtin-reset-m')).toBeNull();
  fireEvent.change(screen.getByTestId('prov-model-name-builtin-m'), { target: { value: 'Edited' } });
  expect(screen.getByTestId('prov-builtin-reset-m').closest('[data-testid="prov-model-card-builtin-m"]')).not.toBeNull();
  fireEvent.click(screen.getByTestId('prov-builtin-reset-m'));
  expect(screen.queryByTestId('prov-builtin-reset-m')).toBeNull();
  expect((screen.getByTestId('prov-model-name-builtin-m') as HTMLInputElement).value).toBe('SDK name');
});

it('opens the advanced accordion with Space and Enter without consuming spaces in inputs', async () => {
  await mountEditor();
  const header = screen.getByTestId('prov-model-advanced-toggle-builtin-m').closest('[role="button"]')!;
  fireEvent.keyDown(header, { key: ' ', code: 'Space' });
  expect(header.getAttribute('aria-expanded')).toBe('true');
  const input = await screen.findByTestId('advanced-builtin-m-samplingParams');
  fireEvent.keyDown(input, { key: ' ', code: 'Space' });
  expect(header.getAttribute('aria-expanded')).toBe('true');
  fireEvent.keyDown(header, { key: ' ', code: 'Space' });
  expect(header.getAttribute('aria-expanded')).toBe('false');
  fireEvent.keyDown(header, { key: 'Enter', code: 'Enter', keyCode: 13 });
  expect(header.getAttribute('aria-expanded')).toBe('true');
});

it('keeps sparse advanced drafts and validation when its accordion is closed and reopened', async () => {
  await mountEditor();
  expect(screen.queryByTestId('advanced-builtin-m')).toBeNull();
  const toggle = screen.getByTestId('prov-model-advanced-toggle-builtin-m');
  fireEvent.click(toggle);
  fireEvent.change(await screen.findByTestId('advanced-builtin-m-samplingParams'), { target: { value: '[1]' } });
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.queryByTestId('advanced-builtin-m')).toBeNull());
  const invalid = JSON.parse(screen.getByTestId('saved').textContent!);
  expect(invalid.m._advancedDrafts.samplingParams).toBe('[1]');
  expect(() => serializeState([{ id: 'openai', name: 'OpenAI', builtIn: true, models: [], modelOverrides: invalid }])).toThrow('必须是 JSON 对象');
  fireEvent.click(toggle);
  const input = await screen.findByTestId('advanced-builtin-m-samplingParams');
  expect((input as HTMLTextAreaElement).value).toBe('[1]');
  fireEvent.change(input, { target: { value: '{"temperature":0}' } });
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.queryByTestId('advanced-builtin-m')).toBeNull());
  const valid = JSON.parse(screen.getByTestId('saved').textContent!);
  const saved = JSON.parse(serializeState([{ id: 'openai', name: 'OpenAI', builtIn: true, models: [], modelOverrides: valid }]).modelsJson);
  expect(saved.providers.openai.modelOverrides.m).toEqual({ samplingParams: { temperature: 0 } });
});

it('hides a model independently of parameter edits and keeps it available for settings management', async () => {
  await mountEditor();
  fireEvent.change(screen.getByTestId('prov-model-name-builtin-m'), { target: { value: 'Edited' } });
  fireEvent.click(screen.getByTestId('prov-builtin-visibility-m'));
  expect(useModelVisibilityStore.getState().hidden).toEqual(['openai\0m']);
  expect(JSON.parse(localStorage.getItem(MODEL_VISIBILITY_STORAGE_KEY)!).hidden).toEqual(['openai\0m']);
  expect(screen.getByTestId('prov-builtin-row-m').getAttribute('data-hidden')).toBe('true');
  expect(screen.getByTestId('prov-model-id-builtin-m')).not.toBeNull();
  expect(JSON.parse(screen.getByTestId('saved').textContent!)).toEqual({ m: { name: 'Edited' } });
  fireEvent.click(screen.getByTestId('prov-builtin-reset-m'));
  expect(useModelVisibilityStore.getState().hidden).toEqual(['openai\0m']);
  fireEvent.click(screen.getByTestId('prov-builtin-visibility-m'));
  expect(useModelVisibilityStore.getState().hidden).toEqual([]);
});

it('can restore hidden routes whose built-in card is replaced or no longer in the SDK directory', async () => {
  vi.mocked(pi.listBuiltinModels).mockResolvedValue([fixture]);
  useModelVisibilityStore.getState().setHidden('openai', 'm', true);
  useModelVisibilityStore.getState().setHidden('openai', 'retired', true);
  render(<BuiltinModelEditor provider={{ id: 'openai', name: 'OpenAI', builtIn: true, models: [{ id: 'm' }] }} onChange={() => {}} />);
  expect(await screen.findByTestId('prov-builtin-restore-m')).not.toBeNull();
  expect(screen.queryByTestId('prov-model-id-builtin-m')).toBeNull();
  fireEvent.click(screen.getByTestId('prov-builtin-restore-m'));
  fireEvent.click(screen.getByTestId('prov-builtin-restore-retired'));
  expect(useModelVisibilityStore.getState().hidden).toEqual([]);
});

it('reports a visibility storage failure without hiding the model or dropping edited parameters', async () => {
  await mountEditor();
  fireEvent.change(screen.getByTestId('prov-model-name-builtin-m'), { target: { value: 'Keep draft' } });
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('disk full'); });
  fireEvent.click(screen.getByTestId('prov-builtin-visibility-m'));
  expect(screen.getByRole('alert').textContent).toContain('disk full');
  expect(useModelVisibilityStore.getState().hidden).toEqual([]);
  expect(screen.getByTestId('prov-builtin-visibility-m').getAttribute('aria-pressed')).toBe('false');
  expect(JSON.parse(screen.getByTestId('saved').textContent!)).toEqual({ m: { name: 'Keep draft' } });
});

it('lets inherited text and context inputs be cleared then replaced without reinserting SDK values', async () => {
  await mountEditor();
  const name = screen.getByTestId('prov-model-name-builtin-m') as HTMLInputElement;
  fireEvent.change(name, { target: { value: '' } });
  expect(name.value).toBe('');
  fireEvent.change(name, { target: { value: 'new' } });
  const context = screen.getByTestId('prov-model-context-builtin-m') as HTMLInputElement;
  fireEvent.change(context, { target: { value: '' } });
  expect(context.value).toBe('');
  fireEvent.change(context, { target: { value: '131072' } });
  expect(JSON.parse(screen.getByTestId('saved').textContent!).m).toEqual({ name: 'new', contextWindow: 131072 });
});

it('retains manufacturer thinking mappings when toggling reasoning off then on', async () => {
  await mountEditor();
  fireEvent.click(screen.getByTestId('prov-model-reasoning-builtin-m'));
  fireEvent.click(screen.getByTestId('prov-model-reasoning-builtin-m'));
  expect((screen.getByTestId('prov-model-map-high-builtin-m') as HTMLInputElement).value).toBe('vendor-high');
  expect(JSON.parse(screen.getByTestId('saved').textContent!).m.thinkingLevelMap).toBeUndefined();
});

it('does not resurrect a cleared protocol through subsequent compatibility edits', async () => {
  await mountEditor();
  fireEvent.mouseDown(screen.getByTestId('prov-model-format-builtin-m').closest('.ant-select')!);
  const option = await waitFor(() => {
    const hit = Array.from(document.querySelectorAll<HTMLElement>('.ant-select-item-option')).find((el) => el.textContent?.startsWith('DeepSeek'));
    if (!hit) throw new Error('missing DeepSeek option');
    return hit;
  });
  fireEvent.click(option);
  fireEvent.click(screen.getByText('消息、角色与工具'));
  fireEvent.click(await screen.findByTestId('prov-compat-supportsStrictMode-builtin-m'));
  const clear = screen.getByTestId('prov-model-format-builtin-m').querySelector('.ant-select-clear')!;
  fireEvent.mouseDown(clear);
  fireEvent.click(clear);
  expect(JSON.parse(screen.getByTestId('saved').textContent!).m.compat.thinkingFormat).toBeUndefined();
  fireEvent.click(screen.getByTestId('prov-compat-supportsDeveloperRole-builtin-m'));
  expect(JSON.parse(screen.getByTestId('saved').textContent!).m.compat).toEqual({ supportsStrictMode: false, supportsDeveloperRole: false });
});

it('removing the last inherited pricing tier through the real card saves an explicit empty array', () => {
  const base: UiModel = { id: 'tiered', api: 'openai-responses', cost: {
    input: 1, output: 2, cacheRead: 0, cacheWrite: 0,
    tiers: [{ inputTokensAbove: 100000, input: 2, output: 4, cacheRead: 0, cacheWrite: 0 }],
  } };
  function Harness() {
    const [override, setOverride] = useState<BuiltinOverride>({});
    return <><ProviderModelCard model={builtinModelDraft(base, override)} index="builtin" api={base.api} expanded lockedIdentity
      onToggle={() => {}} onChange={(patch) => setOverride(patchBuiltinModel(base, override, patch))} />
      <output data-testid="saved">{JSON.stringify(override)}</output></>;
  }
  render(<Harness />);
  fireEvent.click(screen.getByTestId('prov-model-cost-tier-builtin-0-remove'));
  expect(JSON.parse(screen.getByTestId('saved').textContent!)).toEqual({ cost: { tiers: [] } });
  expect(screen.queryByTestId('prov-model-cost-tier-builtin-0-remove')).toBeNull();
});
