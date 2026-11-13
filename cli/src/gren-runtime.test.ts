import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { makeGrenRuntimeFactory } from "./gren-runtime.js";

function fakeDeps(captured: Record<string, unknown>) {
  return {
    createAgentSessionServices: async (opts: Record<string, unknown>) => {
      captured.servicesOptions = opts;
      return { diagnostics: [], modelRuntime: opts.modelRuntime ?? {} };
    },
    createAgentSessionFromServices: async () => ({ session: { settingsManager: SettingsManager.inMemory(), setCacheWarmingMode() {}, dispose() {} } }),
    prepareObservation:(runtime:unknown)=>runtime,
    trackUsage:()=>()=>{},
    manifestExtensions: [
      { name: "safety", factory: () => ({}) },
      { name: "code-exec", manifest: { id: "code-exec" }, factory: () => ({}) },
    ] as never[],
    getConfig: (key: string): string | undefined => (key === "EXTENSIONS_PROFILE" ? "project" : undefined),
  };
}

const extraFactories = [() => {}, () => {}];

test("转发注入的 modelRuntime 到 services", async () => {
  const captured: Record<string, unknown> = {};
  const modelRuntime = { marker: "shared" };
  const factory = makeGrenRuntimeFactory({
    modelRuntime: modelRuntime as never,
    extraFactories,
    deps: fakeDeps(captured) as never,
  });
  await factory({ cwd: "D:/p", agentDir: "D:/a", sessionManager: {} as never });
  assert.equal((captured.servicesOptions as Record<string, unknown>).modelRuntime, modelRuntime);
});

test("allowedExtensionsJson 参与 filterManagedExtensions（只留 core + 白名单 id）", async () => {
  const captured: Record<string, unknown> = {};
  const factory = makeGrenRuntimeFactory({
    allowedExtensionsJson: JSON.stringify(["code-exec"]),
    extraFactories,
    deps: fakeDeps(captured) as never,
  });
  await factory({ cwd: "D:/p", agentDir: "D:/a", sessionManager: {} as never });
  const opts = captured.servicesOptions as { resourceLoaderOptions: { extensionFactories: unknown[] } };
  // safety 恒在（CORE_ALWAYS_ON），code-exec 因白名单命中，再接 extraFactories
  const filteredManifestLength = 2;
  assert.equal(opts.resourceLoaderOptions.extensionFactories.length, filteredManifestLength + extraFactories.length);
});

test("PI_SYSTEM_WORKER 不是 1 时，工厂数等于过滤后的 manifest 再加 extraFactories", async () => {
  const captured: Record<string, unknown> = {};
  const factory = makeGrenRuntimeFactory({
    allowedExtensionsJson: JSON.stringify(["code-exec"]),
    extraFactories,
    deps: fakeDeps(captured) as never,
  });
  await factory({ cwd: "D:/p", agentDir: "D:/a", sessionManager: {} as never });
  const opts = captured.servicesOptions as { resourceLoaderOptions: { extensionFactories: unknown[] } };
  const filteredManifestLength = 2;
  assert.equal(opts.resourceLoaderOptions.extensionFactories.length, filteredManifestLength + extraFactories.length);
});

test("PI_SYSTEM_WORKER 为 1 时不加载扩展，也不追加 extraFactories", async () => {
  const captured: Record<string, unknown> = {};
  const deps = fakeDeps(captured);
  deps.getConfig = (key: string) => (key === "PI_SYSTEM_WORKER" ? "1" : key === "EXTENSIONS_PROFILE" ? "project" : undefined);
  const factory = makeGrenRuntimeFactory({
    extraFactories,
    deps: deps as never,
  });
  await factory({ cwd: "D:/p", agentDir: "D:/a", sessionManager: {} as never });
  const opts = captured.servicesOptions as { resourceLoaderOptions: { extensionFactories: unknown[] } };
  assert.equal(opts.resourceLoaderOptions.extensionFactories.length, 0);
});

function fakeDepsWithSession(captured: Record<string, unknown>, entries: unknown[]) {
  const deps = fakeDeps(captured) as Record<string, unknown>;
  deps.createAgentSessionServices = async (opts: Record<string, unknown>) => {
    captured.servicesOptions = opts;
    captured.modelRuntime = opts.modelRuntime ?? {
      // 只在目录里的模型才算可用；未知 provider/model 返回 undefined，和真 ModelRuntime 一致。
      getModel: (provider: string, id: string) => (provider === 'anthropic' && id === 'claude' ? { provider, id, reasoning: true } : undefined),
      hasConfiguredAuth: () => true,
    };
    return { diagnostics: [], modelRuntime: captured.modelRuntime };
  };
  deps.createAgentSessionFromServices = async (opts: Record<string, unknown>) => {
    captured.sessionOptions = opts;
    return { session: { settingsManager: SettingsManager.inMemory(), setCacheWarmingMode() {}, dispose() {} } };
  };
  return { deps, sessionManager: { getEntries: () => entries } };
}

test("冷恢复：session-preferences 里请求的模型与档位作为初始值传给会话工厂", async () => {
  const captured: Record<string, unknown> = {};
  const entries = [
    { type: "message", message: { role: "user", content: "hi", timestamp: 1 } },
    { type: "model_change", provider: "anthropic", modelId: "claude" },
    { type: "thinking_level_change", thinkingLevel: "off" },
    {
      type: "custom",
      customType: "session-preferences",
      data: { model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high", mode: "plan", revision: 3 },
    },
    // SDK 在 setModel 后追加的 effective 值，不能改写请求的 high
    { type: "thinking_level_change", thinkingLevel: "off" },
  ];
  const { deps, sessionManager } = fakeDepsWithSession(captured, entries);
  const factory = makeGrenRuntimeFactory({ extraFactories, deps: deps as never });
  await factory({ cwd: "D:/p", agentDir: "D:/a", sessionManager: sessionManager as never });
  const sessionOptions = captured.sessionOptions as Record<string, unknown>;
  assert.deepEqual(sessionOptions.thinkingLevel, "high");
  assert.deepEqual((sessionOptions.model as { id: string }).id, "claude");
});

test("冷恢复：canonical 之后的原生显式模型选择不会被回滚成旧模型", async () => {
  const captured: Record<string, unknown> = {};
  const entries = [
    { type: 'custom', customType: 'session-preferences', data: { model: { provider: 'relay', id: 'old' }, thinkingLevel: 'high', revision: 1 } },
    { type: 'model_change', provider: 'relay', modelId: 'new' },
  ];
  const { deps, sessionManager } = fakeDepsWithSession(captured, entries);
  const factory = makeGrenRuntimeFactory({
    extraFactories,
    modelRuntime: { getModel: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true } as never,
    deps: deps as never,
  });
  await factory({ cwd: 'D:/p', agentDir: 'D:/a', sessionManager: sessionManager as never });
  assert.equal((captured.sessionOptions as { model: { id: string } }).model.id, 'new');
  assert.equal((captured.sessionOptions as { thinkingLevel: string }).thinkingLevel, 'high');
});

test("冷恢复：没有 session-preferences 时不干预 SDK 自己的恢复", async () => {
  const captured: Record<string, unknown> = {};
  const entries = [
    { type: "model_change", provider: "anthropic", modelId: "claude" },
    { type: "thinking_level_change", thinkingLevel: "low" },
  ];
  const { deps, sessionManager } = fakeDepsWithSession(captured, entries);
  const factory = makeGrenRuntimeFactory({ extraFactories, deps: deps as never });
  await factory({ cwd: "D:/p", agentDir: "D:/a", sessionManager: sessionManager as never });
  const sessionOptions = captured.sessionOptions as Record<string, unknown>;
  assert.equal(sessionOptions.thinkingLevel, undefined);
  assert.equal(sessionOptions.model, undefined);
});

test("冷恢复：请求的模型不在目录里时不静默换成别的（不传 model，保留会话日志）", async () => {
  const captured: Record<string, unknown> = {};
  const entries = [
    {
      type: "custom",
      customType: "session-preferences",
      data: { model: { provider: "gone", id: "flash" }, revision: 1 },
    },
  ];
  const { deps, sessionManager } = fakeDepsWithSession(captured, entries);
  const factory = makeGrenRuntimeFactory({ extraFactories, deps: deps as never });
  await factory({ cwd: "D:/p", agentDir: "D:/a", sessionManager: sessionManager as never });
  const sessionOptions = captured.sessionOptions as Record<string, unknown>;
  assert.equal(sessionOptions.model, undefined);
});
