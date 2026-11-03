import { beforeEach, describe, expect, it, vi } from 'vitest';

const { piMock, modelsState } = vi.hoisted(() => ({
  piMock: {
    getState: vi.fn(),
    getSessionDefaults: vi.fn(),
    setSessionDefaults: vi.fn(),
    getSettings: vi.fn(),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    setMode: vi.fn(),
    setApproval: vi.fn(),
    setFastMode: vi.fn(),
  },
  modelsState: {
    list: [
      { id: 'm', name: 'My Model', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
      {
        id: 'g',
        name: 'GPT',
        provider: 'openai',
        api: 'openai-completions',
        reasoning: true,
        thinkingLevelMap: { low: 'L', medium: 'M', high: 'H' },
      },
    ] as Array<Record<string, unknown>>,
  },
}));

vi.mock('../../../../lib/pi', () => ({ pi: piMock }));
vi.mock('../../../settings/availableModelsCache', () => ({
  loadAvailableModels: () => Promise.resolve(modelsState.list),
  getCachedAvailableModels: () => modelsState.list,
}));

import {
  __resetComposerPreferencesForTest,
  ensureComposerPreferences,
  saveProjectDefaults,
  writeComposerPreference,
} from './composerPreferences';
import { resetSessionPreferencesForTests, useSessionPreferencesStore } from '../../../../stores/sessionPreferencesStore';

const prefs = (patch: Record<string, unknown> = {}) => ({
  model: { provider: 'anthropic', id: 'm' },
  thinkingLevel: 'medium',
  mode: 'agent',
  approval: 'auto',
  revision: 3,
  ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetComposerPreferencesForTest();
  modelsState.list = [
    { id: 'm', name: 'My Model', provider: 'anthropic', api: 'anthropic-messages', reasoning: true },
    {
      id: 'g',
      name: 'GPT',
      provider: 'openai',
      api: 'openai-completions',
      reasoning: true,
      thinkingLevelMap: { low: 'L', medium: 'M', high: 'H' },
    },
  ];
  piMock.getState.mockResolvedValue({ sessionFile: '/ws/a.jsonl', preferences: prefs() });
  piMock.getSessionDefaults.mockResolvedValue(prefs({ revision: 0 }));
  piMock.setSessionDefaults.mockResolvedValue(prefs({ revision: 1 }));
  piMock.getSettings.mockResolvedValue({});
  piMock.setModel.mockResolvedValue({ ok: true, sessionPath: '/ws/a.jsonl', preferences: prefs(), revision: 4 });
  piMock.setThinkingLevel.mockResolvedValue({ ok: true, sessionPath: '/ws/a.jsonl', preferences: prefs(), revision: 4 });
  piMock.setMode.mockResolvedValue({ ok: true, sessionPath: '/ws/a.jsonl', preferences: prefs(), revision: 4 });
  piMock.setApproval.mockResolvedValue({ ok: true, sessionPath: '/ws/a.jsonl', preferences: prefs(), revision: 4 });
  piMock.setFastMode.mockResolvedValue({ ok: true, sessionPath: '/ws/a.jsonl', preferences: prefs(), revision: 4 });
});

describe('draft preferences', () => {
  it('restores a removed project default mode while keeping the saved draft preferences', async () => {
    piMock.getSessionDefaults.mockResolvedValue(prefs({ mode: 'brainstorm', thinkingLevel: 'high', fastMode: true, revision: 7 }));
    await ensureComposerPreferences('/ws', 'draft:old');
    expect(useSessionPreferencesStore.getState().get('draft:old')).toMatchObject({
      ownerKey: 'draft:old',
      preferences: { mode: 'agent', thinkingLevel: 'high', fastMode: true, revision: 7 },
    });
  });

  it.each(['draft:one', '/ws/a.jsonl'])('rejects a new removed mode write for %s', async (ownerKey) => {
    useSessionPreferencesStore.getState().applyServer(ownerKey, prefs({ mode: 'ask' }));
    const result = await writeComposerPreference('/ws', ownerKey, 'mode', 'brainstorm');
    expect(result).toMatchObject({ ok: false, error: 'save' });
    expect(useSessionPreferencesStore.getState().peek(ownerKey)?.mode).toBe('ask');
  });

  it('initialises a draft from project defaults without touching setters or defaults', async () => {
    piMock.getSessionDefaults.mockResolvedValue(
      prefs({ model: { provider: 'openai', id: 'g' }, thinkingLevel: 'high', mode: 'plan', approval: 'workspace', revision: 0 }),
    );
    const result = await ensureComposerPreferences('/ws', 'draft:one');
    expect(result).toEqual({ ok: true });
    expect(piMock.setModel).not.toHaveBeenCalled();
    expect(piMock.setThinkingLevel).not.toHaveBeenCalled();
    expect(piMock.setSessionDefaults).not.toHaveBeenCalled();
    expect(useSessionPreferencesStore.getState().peek('draft:one')).toMatchObject({
      model: { provider: 'openai', id: 'g' },
      thinkingLevel: 'high',
      mode: 'plan',
      approval: 'workspace',
    });
  });

  it('falls back to the app default model, then the first catalog entry; thinking from the model default', async () => {
    piMock.getSessionDefaults.mockResolvedValue({ revision: 0 });
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'openai/g' });
    await ensureComposerPreferences('/ws', 'draft:one');
    expect(useSessionPreferencesStore.getState().peek('draft:one')).toMatchObject({
      model: { provider: 'openai', id: 'g' },
      thinkingLevel: 'medium',
    });

    resetSessionPreferencesForTests();
    piMock.getSettings.mockResolvedValue({ defaultSessionModel: 'gone/flash' });
    await ensureComposerPreferences('/ws', 'draft:two');
    expect(useSessionPreferencesStore.getState().peek('draft:two')).toMatchObject({
      model: { provider: 'anthropic', id: 'm' },
    });
  });

  it('does not re-initialise an existing draft, and never inherits the last session preferences', async () => {
    useSessionPreferencesStore.getState().patchOptimistic('draft:one', 'thinkingLevel', 'low');
    await ensureComposerPreferences('/ws', 'draft:one');
    expect(piMock.getSessionDefaults).not.toHaveBeenCalled();
    expect(useSessionPreferencesStore.getState().peek('draft:one')?.thinkingLevel).toBe('low');
  });

  it('keeps draft writes local: no setter, no project defaults change', async () => {
    useSessionPreferencesStore.getState().patchOptimistic('draft:one', 'thinkingLevel', 'medium');
    const result = await writeComposerPreference('/ws', 'draft:one', 'approval', 'workspace');
    expect(result.ok).toBe(true);
    expect(piMock.setApproval).not.toHaveBeenCalled();
    expect(useSessionPreferencesStore.getState().peek('draft:one')?.approval).toBe('workspace');
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toBeUndefined();
  });

  it('fails the load visibly instead of treating missing defaults as valid data', async () => {
    piMock.getSessionDefaults.mockRejectedValue(new Error('Electron command is not registered: agent_get_session_defaults'));
    const result = await ensureComposerPreferences('/ws', 'draft:one');
    expect(result.ok).toBe(false);
    expect(useSessionPreferencesStore.getState().get('draft:one')?.error).toBe('load');
    expect(useSessionPreferencesStore.getState().get('draft:one')?.loading).toBe(false);
    // 没写入任何「看起来有效」的偏好，发送前的校验才能拦下它。
    expect(useSessionPreferencesStore.getState().peek('draft:one')).toBeUndefined();
  });
});

describe('session preferences', () => {
  it('restores a removed mode from a setter receipt without inventing a missing revision', async () => {
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    piMock.setThinkingLevel.mockResolvedValue({
      ok: true, sessionPath: '/ws/a.jsonl',
      preferences: { mode: 'brainstorm', thinkingLevel: 'high', approval: 'workspace', fastMode: false },
    });
    const result = await writeComposerPreference('/ws', '/ws/a.jsonl', 'thinkingLevel', 'high');
    expect(result).toEqual({ ok: true });
    expect(useSessionPreferencesStore.getState().get('/ws/a.jsonl')).toMatchObject({
      ownerKey: '/ws/a.jsonl',
      preferences: {
        mode: 'agent', model: { provider: 'anthropic', id: 'm' }, thinkingLevel: 'high',
        approval: 'workspace', fastMode: false, revision: 3,
      },
    });
  });

  it('reads the target session state and never writes it back', async () => {
    const result = await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    expect(result).toEqual({ ok: true });
    expect(piMock.getState).toHaveBeenCalledWith('/ws', '/ws/a.jsonl');
    expect(piMock.setModel).not.toHaveBeenCalled();
    expect(piMock.setThinkingLevel).not.toHaveBeenCalled();
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toMatchObject({
      thinkingLevel: 'medium',
      revision: 3,
    });
  });

  it('refreshes a hydrated cache when re-entering the session (another window wrote rev2)', async () => {
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.revision).toBe(3);

    // 另一个窗口把同一会话改成 low/rev4；本窗口再进入时必须重新读后端。
    piMock.getState.mockResolvedValue({
      sessionFile: '/ws/a.jsonl',
      preferences: prefs({ thinkingLevel: 'low', revision: 4 }),
    });
    const result = await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    expect(result).toEqual({ ok: true });
    expect(piMock.getState).toHaveBeenCalledTimes(2);
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toMatchObject({
      thinkingLevel: 'low',
      revision: 4,
    });
  });

  it('coalesces concurrent refreshes for the same owner into one read', async () => {
    // 三个控件同时挂载：只能打一次 getState。
    await Promise.all([
      ensureComposerPreferences('/ws', '/ws/a.jsonl'),
      ensureComposerPreferences('/ws', '/ws/a.jsonl'),
      ensureComposerPreferences('/ws', '/ws/a.jsonl'),
    ]);
    expect(piMock.getState).toHaveBeenCalledTimes(1);
  });

  it('does not let a slow older read overwrite a newer local pick', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    piMock.getState.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    const slow = ensureComposerPreferences('/ws', '/ws/a.jsonl');
    // 用户在这期间点了 low（乐观写，回执未回）。
    useSessionPreferencesStore.getState().patchOptimistic('/ws/a.jsonl', 'thinkingLevel', 'low');
    // 迟到的旧快照（high/rev3）不得盖回 low。
    resolveFirst({ sessionFile: '/ws/a.jsonl', preferences: prefs({ thinkingLevel: 'high', revision: 3 }) });
    await slow;
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.thinkingLevel).toBe('low');
  });

  it('falls back per field for a legacy session without a preferences snapshot', async () => {    piMock.getState.mockResolvedValue({
      sessionFile: '/ws/a.jsonl',
      model: { provider: 'openai', id: 'g', api: 'openai-completions', reasoning: true },
      thinkingLevel: 'high',
    });
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toMatchObject({
      model: { provider: 'openai', id: 'g' },
      thinkingLevel: 'high',
      // 缺的 mode / approval 用兼容缺省，已有字段不重置。
      mode: 'agent',
      approval: 'auto',
    });
    expect(piMock.setMode).not.toHaveBeenCalled();
    expect(piMock.setApproval).not.toHaveBeenCalled();
  });

  it('does not invent a model for a legacy session that never recorded one', async () => {
    piMock.getState.mockResolvedValue({ sessionFile: '/ws/a.jsonl', thinkingLevel: 'high' });
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    const saved = useSessionPreferencesStore.getState().peek('/ws/a.jsonl');
    expect(saved?.model).toBeUndefined();
    expect(saved?.thinkingLevel).toBe('high');
    // 不把列表首项当成历史会话的模型，否则会把用户的会话悄悄换掉。
    expect(piMock.setModel).not.toHaveBeenCalled();
  });

  it('rejects a snapshot that belongs to another session file', async () => {
    piMock.getState.mockResolvedValue({ sessionFile: '/ws/b.jsonl', preferences: prefs() });
    const result = await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    expect(result.ok).toBe(false);
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toBeUndefined();
  });

  it('routes each setter to the original session path', async () => {
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    await writeComposerPreference('/ws', '/ws/a.jsonl', 'model', { provider: 'openai', id: 'g' });
    await writeComposerPreference('/ws', '/ws/a.jsonl', 'thinkingLevel', 'high');
    await writeComposerPreference('/ws', '/ws/a.jsonl', 'mode', 'plan');
    await writeComposerPreference('/ws', '/ws/a.jsonl', 'approval', 'workspace');
    expect(piMock.setModel).toHaveBeenCalledWith('/ws', 'openai', 'g', '/ws/a.jsonl');
    expect(piMock.setThinkingLevel).toHaveBeenCalledWith('/ws', 'high', '/ws/a.jsonl');
    expect(piMock.setMode).toHaveBeenCalledWith('/ws', 'plan', '/ws/a.jsonl');
    expect(piMock.setApproval).toHaveBeenCalledWith('/ws', 'workspace', '/ws/a.jsonl');
  });

  it('keeps A high and B low for the same model', async () => {
    piMock.getState.mockImplementation(async (_ws: string, path: string) =>
      path === '/ws/a.jsonl'
        ? { sessionFile: '/ws/a.jsonl', preferences: prefs({ thinkingLevel: 'high', revision: 2 }) }
        : { sessionFile: '/ws/b.jsonl', preferences: prefs({ thinkingLevel: 'low', revision: 5 }) },
    );
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    await ensureComposerPreferences('/ws', '/ws/b.jsonl');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.thinkingLevel).toBe('high');
    expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')?.thinkingLevel).toBe('low');
  });

  it('never applies A receipt to B', async () => {
    piMock.getState.mockImplementation(async (_ws: string, path: string) =>
      path === '/ws/a.jsonl'
        ? { sessionFile: '/ws/a.jsonl', preferences: prefs({ thinkingLevel: 'high', revision: 2 }) }
        : { sessionFile: '/ws/b.jsonl', preferences: prefs({ thinkingLevel: 'low', revision: 5 }) },
    );
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    await ensureComposerPreferences('/ws', '/ws/b.jsonl');
    // 回执仍指向 A（写 A 的 setThinkingLevel 迟到完成），B 的值不受影响。
    piMock.setThinkingLevel.mockResolvedValue({
      ok: true,
      sessionPath: '/ws/a.jsonl',
      preferences: prefs({ thinkingLevel: 'max', revision: 9 }),
      revision: 9,
    });
    const result = await writeComposerPreference('/ws', '/ws/b.jsonl', 'thinkingLevel', 'high');
    expect(result.ok).toBe(false);
    // B 回滚到自己已确认的 low，既不接受 A 的 max，也不保留未确认的 high。
    expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')?.thinkingLevel).toBe('low');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.thinkingLevel).toBe('high');
  });

  it('rolls a rejected write back to the confirmed value with a visible message', async () => {
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    piMock.setThinkingLevel.mockRejectedValue(new Error('SESSION_NOT_LOADED'));
    const result = await writeComposerPreference('/ws', '/ws/a.jsonl', 'thinkingLevel', 'max');
    expect(result).toMatchObject({ ok: false, error: 'save' });
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.thinkingLevel).toBe('medium');
    expect(useSessionPreferencesStore.getState().get('/ws/a.jsonl')?.error).toBe('save');
  });

  it('drops a stale receipt and keeps the newer pick', async () => {
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    piMock.setThinkingLevel.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ ok: true, sessionPath: '/ws/a.jsonl', preferences: prefs({ thinkingLevel: 'high' }), revision: 4 }),
            20,
          ),
        ),
    );
    const firstPick = writeComposerPreference('/ws', '/ws/a.jsonl', 'thinkingLevel', 'high');
    piMock.setThinkingLevel.mockResolvedValueOnce({
      ok: true,
      sessionPath: '/ws/a.jsonl',
      preferences: prefs({ thinkingLevel: 'off' }),
      revision: 5,
    });
    const secondPick = writeComposerPreference('/ws', '/ws/a.jsonl', 'thinkingLevel', 'off');
    await Promise.all([firstPick, secondPick]);
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.thinkingLevel).toBe('off');
  });

  it('keeps the saved model when the host reports it unavailable, and asks for a valid pick', async () => {
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    piMock.setModel.mockResolvedValue({
      ok: true,
      sessionPath: '/ws/a.jsonl',
      preferences: prefs({ model: { provider: 'gone', id: 'flash' } }),
      revision: 4,
      unavailable: ['model'],
    });
    const result = await writeComposerPreference('/ws', '/ws/a.jsonl', 'model', { provider: 'gone', id: 'flash' });
    expect(result).toMatchObject({ ok: false, error: 'unavailable' });
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.model).toEqual({ provider: 'gone', id: 'flash' });
  });

  it('keeps the saved thinking preference when only an effective level is available', async () => {
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    piMock.setThinkingLevel.mockResolvedValue({
      ok: true,
      sessionPath: '/ws/a.jsonl',
      preferences: prefs({ thinkingLevel: 'max' }),
      revision: 4,
      unavailable: ['thinkingLevel'],
    });
    const result = await writeComposerPreference('/ws', '/ws/a.jsonl', 'thinkingLevel', 'max');
    expect(result).toMatchObject({ ok: true, effectiveOnly: true });
    // 不自动写回：保存值保持用户点的 max，由 UI 单独显示有效档位。
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.thinkingLevel).toBe('max');
  });

  it('returns the Plan guard refusal and rolls the optimistic mode back', async () => {
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    piMock.setMode.mockResolvedValue({
      ok: false,
      blocked: 'PLAN_UNCONFIRMED',
      mode: 'agent',
      message: '当前会话有尚未确认的计划，不能直接切到执行模式。',
      sessionPath: '/ws/a.jsonl',
    });
    const result = await writeComposerPreference('/ws', '/ws/a.jsonl', 'mode', 'agent');
    expect(result).toMatchObject({ ok: false, error: 'blocked' });
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.mode).toBe('agent');
  });
});

describe('project defaults', () => {
  it('writes all four through the explicit defaults command', async () => {
    const snapshot = prefs({ thinkingLevel: 'high', mode: 'ask', approval: 'readonly', revision: 0 });
    piMock.setSessionDefaults.mockImplementation(async (_ws: string, saved: unknown) => saved);
    const result = await saveProjectDefaults('/ws', snapshot);
    expect(result).toEqual({ ok: true });
    expect(piMock.setSessionDefaults).toHaveBeenCalledWith('/ws', snapshot);
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toMatchObject({
      thinkingLevel: 'high',
      mode: 'ask',
      approval: 'readonly',
    });
    // 只写默认，不改任何现有会话。
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')).toBeUndefined();
  });

  it('surfaces a defaults save failure instead of pretending it succeeded', async () => {
    piMock.setSessionDefaults.mockRejectedValue(new Error('disk full'));
    const result = await saveProjectDefaults('/ws', prefs({ revision: 0 }));
    expect(result).toMatchObject({ ok: false, message: 'disk full' });
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toBeUndefined();
  });
});

describe('Fast is a per-session preference', () => {
  const fastPrefs = (patch: Record<string, unknown> = {}) => prefs(patch);

  it('initialises a draft with Fast off, even when the legacy global store said on', async () => {
    piMock.getSessionDefaults.mockResolvedValue(fastPrefs({ revision: 0 }));
    await ensureComposerPreferences('/ws', 'draft:one');
    expect(useSessionPreferencesStore.getState().peek('draft:one')?.fastMode).toBe(false);
    expect(piMock.setFastMode).not.toHaveBeenCalled();
  });

  it('lets an explicit project default turn Fast on for a new draft', async () => {
    piMock.getSessionDefaults.mockResolvedValue(fastPrefs({ fastMode: true, revision: 0 }));
    await ensureComposerPreferences('/ws', 'draft:one');
    expect(useSessionPreferencesStore.getState().peek('draft:one')?.fastMode).toBe(true);
    expect(useSessionPreferencesStore.getState().peek('draft:one')?.thinkingLevel).toBe('medium');
  });

  it('keeps draft Fast writes local: no setter, no project defaults change', async () => {
    await ensureComposerPreferences('/ws', 'draft:one');
    const on = await writeComposerPreference('/ws', 'draft:one', 'fastMode', true);
    expect(on.ok).toBe(true);
    expect(piMock.setFastMode).not.toHaveBeenCalled();
    expect(useSessionPreferencesStore.getState().peek('draft:one')?.fastMode).toBe(true);
    const off = await writeComposerPreference('/ws', 'draft:one', 'fastMode', false);
    expect(off.ok).toBe(true);
    // false 不能被 truthy 过滤：草稿读回就是关闭。
    expect(useSessionPreferencesStore.getState().peek('draft:one')?.fastMode).toBe(false);
    expect(piMock.setSessionDefaults).not.toHaveBeenCalled();
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']).toBeUndefined();
  });

  it('keeps Fast off for an old session that never recorded the field', async () => {
    piMock.getState.mockResolvedValue({
      sessionFile: '/ws/a.jsonl',
      preferences: fastPrefs({ revision: 2 }),
    });
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    const saved = useSessionPreferencesStore.getState().peek('/ws/a.jsonl');
    // 缺字段按关闭展示（显式 false），但不写回会话。
    expect(saved?.fastMode).toBe(false);
    expect(saved?.thinkingLevel).toBe('medium');
    expect(piMock.setFastMode).not.toHaveBeenCalled();
  });

  it('writes Fast through the session command with the original path', async () => {
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    const result = await writeComposerPreference('/ws', '/ws/a.jsonl', 'fastMode', true);
    expect(result.ok).toBe(true);
    expect(piMock.setFastMode).toHaveBeenCalledWith('/ws', true, '/ws/a.jsonl');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.fastMode).toBe(true);
    // 不改其它四项。
    expect(piMock.setModel).not.toHaveBeenCalled();
    expect(piMock.setThinkingLevel).not.toHaveBeenCalled();
    expect(piMock.setMode).not.toHaveBeenCalled();
    expect(piMock.setApproval).not.toHaveBeenCalled();
  });

  it('writes Fast off as false, not as a missing field', async () => {
    piMock.getState.mockResolvedValue({
      sessionFile: '/ws/a.jsonl',
      preferences: fastPrefs({ fastMode: true, revision: 4 }),
    });
    piMock.setFastMode.mockResolvedValue({
      ok: true,
      sessionPath: '/ws/a.jsonl',
      preferences: fastPrefs({ fastMode: false, revision: 5 }),
      revision: 5,
    });
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    const result = await writeComposerPreference('/ws', '/ws/a.jsonl', 'fastMode', false);
    expect(result.ok).toBe(true);
    expect(piMock.setFastMode).toHaveBeenCalledWith('/ws', false, '/ws/a.jsonl');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.fastMode).toBe(false);
  });

  it('keeps A on and B off for the same provider and model', async () => {
    piMock.getState.mockImplementation(async (_ws: string, path: string) =>
      path === '/ws/a.jsonl'
        ? { sessionFile: '/ws/a.jsonl', preferences: fastPrefs({ fastMode: true, revision: 2 }) }
        : { sessionFile: '/ws/b.jsonl', preferences: fastPrefs({ fastMode: false, revision: 3 }) },
    );
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    await ensureComposerPreferences('/ws', '/ws/b.jsonl');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.fastMode).toBe(true);
    expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')?.fastMode).toBe(false);
    expect(piMock.setFastMode).not.toHaveBeenCalled();
  });

  it('does not inherit the legacy global fast-mode.json value', async () => {
    // 旧共享文件里同模型是 true；新会话没有该字段时必须按关闭展示，也不读旧 getter。
    piMock.getState.mockResolvedValue({ sessionFile: '/ws/a.jsonl', preferences: fastPrefs({ revision: 2 }) });
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.fastMode).not.toBe(true);
    expect(piMock.getModelFastPreferences).toBeUndefined();
  });

  it('rolls a rejected Fast write back to the confirmed value with a visible error', async () => {
    piMock.getState.mockResolvedValue({
      sessionFile: '/ws/a.jsonl',
      preferences: fastPrefs({ fastMode: true, revision: 4 }),
    });
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    piMock.setFastMode.mockRejectedValue(new Error('SESSION_NOT_LOADED'));
    const result = await writeComposerPreference('/ws', '/ws/a.jsonl', 'fastMode', false);
    expect(result).toMatchObject({ ok: false, error: 'save' });
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.fastMode).toBe(true);
    expect(useSessionPreferencesStore.getState().get('/ws/a.jsonl')?.error).toBe('save');
  });

  it('keeps the saved Fast value when the capability is unavailable', async () => {
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    piMock.setFastMode.mockResolvedValue({
      ok: true,
      sessionPath: '/ws/a.jsonl',
      preferences: fastPrefs({ fastMode: true, revision: 4 }),
      revision: 4,
      unavailable: ['fastMode'],
    });
    const result = await writeComposerPreference('/ws', '/ws/a.jsonl', 'fastMode', true);
    // 能力撤销只影响生效值：保存的会话开关必须留着，换回支持的模型时恢复。
    expect(result.ok).toBe(true);
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.fastMode).toBe(true);
    expect(useSessionPreferencesStore.getState().get('/ws/a.jsonl')?.error).toBeNull();
  });

  it('never applies a Fast receipt that belongs to another session', async () => {
    piMock.getState.mockImplementation(async (_ws: string, path: string) =>
      path === '/ws/a.jsonl'
        ? { sessionFile: '/ws/a.jsonl', preferences: fastPrefs({ fastMode: true, revision: 2 }) }
        : { sessionFile: '/ws/b.jsonl', preferences: fastPrefs({ fastMode: false, revision: 3 }) },
    );
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    await ensureComposerPreferences('/ws', '/ws/b.jsonl');
    piMock.setFastMode.mockResolvedValue({
      ok: true,
      sessionPath: '/ws/a.jsonl',
      preferences: fastPrefs({ fastMode: true, revision: 9 }),
      revision: 9,
    });
    const result = await writeComposerPreference('/ws', '/ws/b.jsonl', 'fastMode', true);
    expect(result.ok).toBe(false);
    expect(useSessionPreferencesStore.getState().peek('/ws/b.jsonl')?.fastMode).toBe(false);
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.fastMode).toBe(true);
  });
});

describe('Fast on a legacy session without the field', () => {
  it('shows the legacy session as off and writes that off into project defaults', async () => {
    // 旧会话没有 fastMode：UI 显示关闭，且「设为项目默认」必须把 false 一起写出去，
    // 否则宿主合并旧默认（可能是 true）会让新草稿莫名开着。
    piMock.getState.mockResolvedValue({
      sessionFile: '/ws/a.jsonl',
      model: { provider: 'anthropic', id: 'm' },
      thinkingLevel: 'high',
    });
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    const saved = useSessionPreferencesStore.getState().peek('/ws/a.jsonl');
    expect(saved?.fastMode).toBe(false);
    // 只补展示值：不调 setter、不落盘。
    expect(piMock.setFastMode).not.toHaveBeenCalled();

    piMock.setSessionDefaults.mockImplementation(async (_ws: string, value: unknown) => value);
    const result = await saveProjectDefaults('/ws', saved!);
    expect(result.ok).toBe(true);
    expect(piMock.setSessionDefaults).toHaveBeenCalledWith('/ws', expect.objectContaining({ fastMode: false }));
    expect(useSessionPreferencesStore.getState().defaultsByWorkspace['/ws']?.fastMode).toBe(false);
  });

  it('keeps an explicit false from the session record rather than inventing true', async () => {
    piMock.getState.mockResolvedValue({
      sessionFile: '/ws/a.jsonl',
      preferences: prefs({ fastMode: false, revision: 4 }),
    });
    await ensureComposerPreferences('/ws', '/ws/a.jsonl');
    expect(useSessionPreferencesStore.getState().peek('/ws/a.jsonl')?.fastMode).toBe(false);
  });
});
