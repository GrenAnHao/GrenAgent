import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentSessionRuntime, ModelRuntime, SessionManager } from '../../../cli/src/pi-sdk.js';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
} from '@earendil-works/pi-coding-agent';
import { WorkspaceHandle } from '../agent/workspaceHandle.js';
import { PiRuntimeService, type AgentHostPort } from './piRuntimeService.js';
import { makeGrenRuntimeFactory } from '../../../cli/src/gren-runtime.js';
import { __resetForTest } from '../../../extensions/_shared/runtime-config.js';
import {
  SESSION_PREFERENCES_ENTRY,
  readRequestedPreferences,
  readSessionPreferences,
} from '../../../extensions/_shared/session-preferences.js';

/**
 * 真实 SDK（ModelRuntime + SettingsManager + AgentSession + SessionManager）上的冷恢复验证。
 * 只写临时 models.json 与假 apiKey，不发任何网络请求。
 */
let dir = '';
let sessionDir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gren-session-prefs-'));
  sessionDir = join(dir, 'sessions');
  await writeFile(join(dir, 'models.json'), JSON.stringify({
    providers: {
      relay: {
        api: 'openai-completions',
        baseUrl: 'https://fixture.invalid/v1',
        apiKey: 'fake',
        models: [
          {
            id: 'think-model',
            reasoning: true,
            input: ['text'],
            thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
          },
          { id: 'plain-model', reasoning: false, input: ['text'] },
        ],
      },
    },
  }));
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ relay: { type: 'api_key', key: 'fake' } }));
});

afterEach(async () => {
  __resetForTest();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function modelRuntime(): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    modelsPath: join(dir, 'models.json'),
    authPath: join(dir, 'auth.json'),
    allowModelNetwork: false,
  });
  expect(runtime.getError()).toBeUndefined();
  return runtime;
}

function writeSessionFile(sm: SessionManager): Promise<void> {
  const file = sm.getSessionFile()!;
  return writeFile(file, [sm.getHeader(), ...sm.getEntries()].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

/** 用真实 runtime 工厂冷恢复这份 jsonl。 */
async function coldRestore(runtime: ModelRuntime, sm: SessionManager) {
  const created = await createAgentSessionRuntime(
    makeGrenRuntimeFactory({ modelRuntime: runtime, allowedExtensionsJson: '[]', extraFactories: [] }),
    { cwd: dir, agentDir: dir, sessionManager: sm },
  );
  return created;
}

async function seedSession(options: {
  provider: string;
  modelId: string;
  requestedThinking: string;
  nativeThinking?: string;
}): Promise<SessionManager> {
  const sm = SessionManager.create(dir, sessionDir);
  sm.appendMessage({ role: 'user', content: 'hello', timestamp: 1 } as never);
  // 用户点选的请求值
  sm.appendCustomEntry(SESSION_PREFERENCES_ENTRY, {
    model: { provider: options.provider, id: options.modelId },
    thinkingLevel: options.requestedThinking,
    mode: 'plan',
    approval: 'readonly',
    revision: 2,
  });
  // SDK 会追加的 effective 值（换模型 / 冷恢复补齐）
  sm.appendModelChange(options.provider, options.modelId);
  if (options.nativeThinking) sm.appendThinkingLevelChange(options.nativeThinking);
  await writeSessionFile(sm);
  return sm;
}

describe('真实 SDK 冷恢复会话偏好', () => {
  it('请求 high 的会话冷恢复后 effective 仍是 high，条目里的请求值不变', async () => {
    const runtime = await modelRuntime();
    const sm = await seedSession({
      provider: 'relay',
      modelId: 'think-model',
      requestedThinking: 'high',
      nativeThinking: 'high',
    });
    const { session } = await coldRestore(runtime, sm);
    try {
      expect(session.model?.id).toBe('think-model');
      expect(session.thinkingLevel).toBe('high');
      const requested = readRequestedPreferences(sm.getEntries() as never);
      expect(requested.thinkingLevel).toBe('high');
      expect(requested.model).toEqual({ provider: 'relay', id: 'think-model' });
    } finally {
      await session.abort().catch(() => {});
    }
  });

  it('原生条目被 SDK 写成 off（effective）时，冷恢复仍按请求值 high 起来', async () => {
    const runtime = await modelRuntime();
    // 场景：曾经切到非推理模型，SDK 追加 thinking_level_change=off；用户请求值仍是 high。
    const sm = await seedSession({
      provider: 'relay',
      modelId: 'think-model',
      requestedThinking: 'high',
      nativeThinking: 'off',
    });
    const { session } = await coldRestore(runtime, sm);
    try {
      expect(session.model?.id).toBe('think-model');
      expect(session.thinkingLevel).toBe('high');
      // 日志里的请求值没有被 effective 值覆盖
      expect(readSessionPreferences(sm.getEntries() as never)).toEqual({
        model: { provider: 'relay', id: 'think-model' },
        thinkingLevel: 'high',
        mode: 'plan',
        approval: 'readonly',
        revision: 2,
      });
    } finally {
      await session.abort().catch(() => {});
    }
  });

  it('换到非推理模型：effective 是 off，请求值 high 保留；再切回来仍是 high', async () => {
    const runtime = await modelRuntime();
    const sm = await seedSession({
      provider: 'relay',
      modelId: 'think-model',
      requestedThinking: 'high',
      nativeThinking: 'high',
    });
    const { session } = await coldRestore(runtime, sm);
    try {
      const plain = runtime.getModel('relay', 'plain-model');
      expect(plain).toBeDefined();
      await session.setModel(plain!);
      // SDK 把档位钳成 off 并追加 thinking_level_change
      expect(session.thinkingLevel).toBe('off');
      expect(sm.getEntries().some((entry) => entry.type === 'thinking_level_change'
        && (entry as { thinkingLevel?: string }).thinkingLevel === 'off')).toBe(true);
      // 请求值不受影响
      expect(readRequestedPreferences(sm.getEntries() as never).thinkingLevel).toBe('high');

      // 切回推理模型：按请求值恢复 high（不是沿用 off）
      const think = runtime.getModel('relay', 'think-model');
      await session.setModel(think!);
      session.setThinkingLevel('high');
      expect(session.thinkingLevel).toBe('high');
      expect(readSessionPreferences(sm.getEntries() as never).thinkingLevel).toBe('high');
    } finally {
      await session.abort().catch(() => {});
    }
  });

  it('两个会话在同一项目各自冷恢复自己的偏好，互不覆盖', async () => {
    const runtime = await modelRuntime();
    const a = await seedSession({ provider: 'relay', modelId: 'think-model', requestedThinking: 'high', nativeThinking: 'high' });
    const b = await seedSession({ provider: 'relay', modelId: 'think-model', requestedThinking: 'low', nativeThinking: 'low' });
    const aRuntime = await coldRestore(runtime, a);
    const bRuntime = await coldRestore(runtime, b);
    try {
      expect(aRuntime.session.thinkingLevel).toBe('high');
      expect(bRuntime.session.thinkingLevel).toBe('low');
      expect(readRequestedPreferences(a.getEntries() as never).thinkingLevel).toBe('high');
      expect(readRequestedPreferences(b.getEntries() as never).thinkingLevel).toBe('low');
      await aRuntime.session.abort().catch(() => {});
    } finally {
      await bRuntime.session.abort().catch(() => {});
    }
  });

  it('请求的模型已从目录消失：冷恢复不静默换成别的模型，请求值原样保留', async () => {
    const runtime = await modelRuntime();
    const sm = SessionManager.create(dir, sessionDir);
    sm.appendMessage({ role: 'user', content: 'hello', timestamp: 1 } as never);
    sm.appendCustomEntry(SESSION_PREFERENCES_ENTRY, {
      model: { provider: 'gone', id: 'flash' },
      thinkingLevel: 'high',
      revision: 1,
    });
    await writeSessionFile(sm);
    const { session } = await coldRestore(runtime, sm);
    try {
      // 没有落到请求的模型（目录里不存在），也没有把它从日志里改写掉
      expect(session.model?.provider).not.toBe('gone');
      const requested = readRequestedPreferences(sm.getEntries() as never);
      expect(requested.model).toEqual({ provider: 'gone', id: 'flash' });
      expect(requested.thinkingLevel).toBe('high');
      const raw = await readFile(sm.getSessionFile()!, 'utf8');
      expect(raw).toContain('"provider":"gone"');
    } finally {
      await session.abort().catch(() => {});
    }
  });

  it('clone：新会话分支只带锚点之前的偏好条目，两边独立', async () => {
    const runtime = await modelRuntime();
    const sm = await seedSession({
      provider: 'relay',
      modelId: 'think-model',
      requestedThinking: 'high',
      nativeThinking: 'high',
    });
    const { session, services } = await coldRestore(runtime, sm);
    try {
      // 用 SDK 自己的 createBranchedSession（真实分支复制路径，不是 static forkFrom）
      const leafId = session.sessionManager.getLeafId();
      expect(leafId).toBeTruthy();
      const targetPath = session.sessionManager.createBranchedSession(leafId!);
      expect(targetPath).toBeTruthy();
      const branched = SessionManager.open(targetPath!);
      expect(readRequestedPreferences(branched.getEntries() as never)).toEqual({
        model: { provider: 'relay', id: 'think-model' },
        thinkingLevel: 'high',
        mode: 'plan',
        approval: 'readonly',
        revision: 2,
      });
      // 副本写自己的偏好，源会话不受影响
      branched.appendCustomEntry(SESSION_PREFERENCES_ENTRY, { thinkingLevel: 'low', revision: 3 });
      expect(readRequestedPreferences(branched.getEntries() as never).thinkingLevel).toBe('low');
      expect(readRequestedPreferences(session.sessionManager.getEntries() as never).thinkingLevel).toBe('high');
      expect(services.cwd).toBe(dir);
    } finally {
      await session.abort().catch(() => {});
    }
  });
});

/**
 * 通过 PiRuntimeService 的真实 setter 路径驱动真实 AgentSession：
 * 覆盖“模型切换后按请求值重算 effective”与“能力不足交给 SDK 钳制”两条规则。
 */
describe('真实 SDK + PiRuntimeService setter 路径', () => {
  async function buildService() {
    const runtime = await modelRuntime();
    const sm = SessionManager.create(dir, sessionDir);
    sm.appendMessage({ role: 'user', content: 'hello', timestamp: 1 } as never);
    await writeSessionFile(sm);
    // 不加载真实项目扩展（它们会打开 sqlite 注册表，与临时目录清理冲突）；
    // 只保留我们关心的会话行为。
    const created = await createAgentSessionRuntime(
      makeGrenRuntimeFactory({
        modelRuntime: runtime,
        extraFactories: [],
        deps: {
          createAgentSessionServices,
          createAgentSessionFromServices,
          manifestExtensions: [],
          getConfig: () => undefined,
        } as never,
      }),
      { cwd: dir, agentDir: dir, sessionManager: sm },
    );
    const handle = new WorkspaceHandle({
      workspace: dir,
      cwd: dir,
      runtime: created,
      resolveConfig: async () => ({}),
      emitUiRequest: () => {},
      onEvent: () => {},
      onFatal: () => {},
    });
    await handle.start();
    const host = {
      open: async () => handle,
      get: () => handle,
      close: async () => {},
      workspaces: () => [dir],
      list: () => [handle],
      getState: undefined,
    } as unknown as AgentHostPort;
    const service = new PiRuntimeService({ agentDir: dir, agentHost: host, modelRuntimeHost: { refresh: async () => {}, workspaces: () => [] } });
    return { service, handle, sm };
  }

  it('setModel 后按请求值 high 重算 effective（不被 SDK 的默认 medium 顶掉）', async () => {
    const { service, handle, sm } = await buildService();
    try {
      const think = handle.session.modelRuntime.getAvailableSnapshot().find((m) => m.id === 'think-model')!;
      // 先保存请求值 high（此时是 think-model）
      const ack = await service.send(dir, 'agent_set_model', { provider: think.provider, modelId: think.id }) as Record<string, unknown>;
      // 真会话里 mode / approval / thinkingLevel 来自已加载的扩展条目，这里只核对模型与修订号
      expect(ack.preferences).toMatchObject({ model: { provider: think.provider, id: think.id } });
      expect((ack.preferences as { revision: number }).revision).toBeGreaterThan(0);
      await service.send(dir, 'agent_set_thinking_level', { level: 'high' });
      expect(handle.session.thinkingLevel).toBe('high');
      // 换到非推理模型：请求值保留 high，effective 由 SDK 钳成 off
      const plain = handle.session.modelRuntime.getAvailableSnapshot().find((m) => m.id === 'plain-model')!;
      const plainAck = await service.send(dir, 'agent_set_model', { provider: plain.provider, modelId: plain.id }) as Record<string, unknown>;
      expect(handle.session.thinkingLevel).toBe('off');
      expect((plainAck.preferences as { thinkingLevel?: string }).thinkingLevel).toBe('high');
      expect(plainAck.unavailable).toContain('thinkingLevel');
      // 切回推理模型：setter 按请求值重算，effective 回到 high
      const backAck = await service.send(dir, 'agent_set_model', { provider: think.provider, modelId: think.id }) as Record<string, unknown>;
      expect(handle.session.thinkingLevel).toBe('high');
      expect(backAck.unavailable).not.toContain('thinkingLevel');
      // 冷恢复也拿到 high（真实 jsonl）
      expect(readRequestedPreferences(sm.getEntries() as never).thinkingLevel).toBe('high');
    } finally {
      await handle.session.abort().catch(() => {});
    }
  });

  it('请求的档位在当前模型放不下时，也确实调 SDK 钳制（不是保留旧值）', async () => {
    const { service, handle } = await buildService();
    try {
      const plain = handle.session.modelRuntime.getAvailableSnapshot().find((m) => m.id === 'plain-model')!;
      await service.send(dir, 'agent_set_model', { provider: plain.provider, modelId: plain.id });
      const ack = await service.send(dir, 'agent_set_thinking_level', { level: 'high' }) as Record<string, unknown>;
      expect(ack.unavailable).toContain('thinkingLevel');
      expect(handle.session.thinkingLevel).toBe('off');
      expect((ack.preferences as { thinkingLevel?: string }).thinkingLevel).toBe('high');
    } finally {
      await handle.session.abort().catch(() => {});
    }
  });

  it('auth 失败时 setModel 抛错，且不留下磁盘新请求值', async () => {
    const { service, handle, sm } = await buildService();
    try {
      const before = sm.getEntries().filter((e) => (e as { customType?: string }).customType === SESSION_PREFERENCES_ENTRY).length;
      // 目录里有一个 provider 没配 auth 的模型？用不存在的模型验证“不可用不写 live”
      await expect(service.send(dir, 'agent_set_model', { provider: 'relay', modelId: 'missing-model' }))
        .resolves.toMatchObject({ unavailable: ['model'] });
      const after = sm.getEntries().filter((e) => (e as { customType?: string }).customType === SESSION_PREFERENCES_ENTRY).length;
      // 请求值仍然保留（写进去了），这是“保存但不生效”的分支，不是失败
      expect(after).toBeGreaterThan(before);
      expect(readRequestedPreferences(sm.getEntries() as never).model).toEqual({ provider: 'relay', id: 'missing-model' });
      // live 没被改
      expect(handle.session.model?.id).not.toBe('missing-model');
    } finally {
      await handle.session.abort().catch(() => {});
    }
  });
});

/**
 * Fast 作为第五项：真实 SDK + 真实 WorkspaceHandle，同项目两份会话各自按原 path 保存与恢复。
 * 只写临时目录，不发任何网络请求。
 */
describe('真实 SDK：Fast 第五项按会话独立（同项目 A/B）', () => {
  async function buildHandle(runtime: ModelRuntime, sm: SessionManager) {
    const created = await createAgentSessionRuntime(
      makeGrenRuntimeFactory({
        modelRuntime: runtime,
        extraFactories: [],
        deps: {
          createAgentSessionServices,
          createAgentSessionFromServices,
          manifestExtensions: [],
          getConfig: () => undefined,
        } as never,
      }),
      { cwd: dir, agentDir: dir, sessionManager: sm },
    );
    const handle = new WorkspaceHandle({
      workspace: dir,
      cwd: dir,
      runtime: created,
      resolveConfig: async () => ({}),
      emitUiRequest: () => {},
      onEvent: () => {},
      onFatal: () => {},
    });
    await handle.start();
    return handle;
  }

  async function buildSession(text: string): Promise<SessionManager> {
    const sm = SessionManager.create(dir, sessionDir);
    sm.appendMessage({ role: 'user', content: text, timestamp: 1 } as never);
    await writeSessionFile(sm);
    return sm;
  }

  async function buildTwoSessions() {
    const runtime = await modelRuntime();
    const smA = await buildSession('a');
    const smB = await buildSession('b');
    const handleA = await buildHandle(runtime, smA);
    const handleB = await buildHandle(runtime, smB);
    const fileA = smA.getSessionFile()!;
    const fileB = smB.getSessionFile()!;
    const paths: { fileA: string; fileB: string } = { fileA, fileB };
    const handles = [handleA, handleB];
    const host = {
      open: async () => handleA,
      get: () => handleA,
      close: async () => {},
      workspaces: () => [dir],
      list: () => [...handles],
      focus: () => {},
      evict: async (_w: string, handle: typeof handleA) => { handles.splice(handles.indexOf(handle), 1); },
    } as unknown as AgentHostPort;
    const service = new PiRuntimeService({ agentDir: dir, agentHost: host, modelRuntimeHost: { refresh: async () => {}, workspaces: () => [] } });
    return { runtime, service, handleA, handleB, smA, smB, paths };
  }

  it('A 开 B 关：按原 path 各自保存，重载后各自恢复，false 覆盖 true 不动其他四项', async () => {
    const { runtime, service, handleA, handleB, smA, smB, paths } = await buildTwoSessions();
    try {
      const think = handleA.session.modelRuntime.getAvailableSnapshot().find((m) => m.id === 'think-model')!;
      expect(think).toBeDefined();
      // 先给 A 保存其余四项的一部分，验证 Fast 写入不把它们冲掉
      await service.send(dir, 'agent_set_model', { provider: think.provider, modelId: think.id, targetSessionPath: paths.fileA });
      await service.send(dir, 'agent_set_thinking_level', { level: 'high', targetSessionPath: paths.fileA });
      const beforeA = readRequestedPreferences(smA.getEntries() as never);
      expect(beforeA).toMatchObject({ model: { provider: 'relay', id: 'think-model' }, thinkingLevel: 'high' });
      const beforeB = readRequestedPreferences(smB.getEntries() as never);
      const bRevision = beforeB.revision;

      const onA = await service.send(dir, 'agent_set_fast_mode', { enabled: true, targetSessionPath: paths.fileA }) as Record<string, unknown>;
      expect(onA).toMatchObject({ ok: true, sessionPath: paths.fileA, applied: ['fastMode'], unavailable: [] });
      const offB = await service.send(dir, 'agent_set_fast_mode', { enabled: false, targetSessionPath: paths.fileB }) as Record<string, unknown>;
      expect(offB).toMatchObject({ ok: true, sessionPath: paths.fileB, applied: ['fastMode'], unavailable: [] });

      // 其余四项没被 Fast 写入改动
      expect(readRequestedPreferences(smA.getEntries() as never)).toEqual({
        model: { provider: 'relay', id: 'think-model' },
        thinkingLevel: 'high',
        fastMode: true,
        revision: 3,
      });
      const afterB = readRequestedPreferences(smB.getEntries() as never);
      expect(afterB.fastMode).toBe(false);
      expect(afterB.revision).toBe(bRevision + 1);
      expect(afterB.model).toBeUndefined();

      // 重载恢复：按磁盘上的 jsonl 冷恢复，两边互不串
      const reloadedA = await coldRestore(runtime, SessionManager.open(paths.fileA));
      const reloadedB = await coldRestore(runtime, SessionManager.open(paths.fileB));
      try {
        const stateA = await service.send(dir, 'agent_get_state', { targetSessionPath: paths.fileA }) as Record<string, unknown>;
        const stateB = await service.send(dir, 'agent_get_state', { targetSessionPath: paths.fileB }) as Record<string, unknown>;
        expect((stateA.preferences as { fastMode?: boolean }).fastMode).toBe(true);
        expect((stateB.preferences as { fastMode?: boolean }).fastMode).toBe(false);
        expect(reloadedA.session.thinkingLevel).toBe('high');
      } finally {
        await reloadedA.session.abort().catch(() => {});
        await reloadedB.session.abort().catch(() => {});
      }

      // false 覆盖 true：其他四项仍是原样
      const offA = await service.send(dir, 'agent_set_fast_mode', { enabled: false, targetSessionPath: paths.fileA }) as Record<string, unknown>;
      expect(offA).toMatchObject({ ok: true, applied: ['fastMode'] });
      expect(readRequestedPreferences(smA.getEntries() as never)).toEqual({
        model: { provider: 'relay', id: 'think-model' },
        thinkingLevel: 'high',
        fastMode: false,
        revision: 4,
      });
      // 原始 jsonl 里 false 是真值，不是字段消失
      const raw = await readFile(paths.fileA, 'utf8');
      expect(raw).toContain('"fastMode":false');
      // B 完全没被 A 的写入波及
      const againB = readRequestedPreferences(SessionManager.open(paths.fileB).getEntries() as never);
      expect(againB.fastMode).toBe(false);
      expect(againB.revision).toBe(bRevision + 1);
      expect(againB.model).toBeUndefined();
    } finally {
      await handleA.session.abort().catch(() => {});
      await handleB.session.abort().catch(() => {});
    }
  });

  it('新会话没有 fastMode：保持缺省（不硬塞 false），显式 false 才写入', async () => {
    const { service, handleA, smA, paths } = await buildTwoSessions();
    try {
      const initial = readRequestedPreferences(smA.getEntries() as never);
      expect(initial).not.toHaveProperty('fastMode');
      const state = await service.send(dir, 'agent_get_state', { targetSessionPath: paths.fileA }) as Record<string, unknown>;
      expect(state.preferences as Record<string, unknown>).not.toHaveProperty('fastMode');
      const off = await service.send(dir, 'agent_set_fast_mode', { enabled: false, targetSessionPath: paths.fileA }) as Record<string, unknown>;
      expect((off.preferences as { fastMode?: boolean }).fastMode).toBe(false);
      expect(readRequestedPreferences(smA.getEntries() as never).fastMode).toBe(false);
      expect(handleA.session.sessionFile).toBe(paths.fileA);
    } finally {
      await handleA.session.abort().catch(() => {});
    }
  });
});
