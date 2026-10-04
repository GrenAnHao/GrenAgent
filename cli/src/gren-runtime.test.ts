import assert from "node:assert/strict";
import { test } from "node:test";
import { makeGrenRuntimeFactory } from "./gren-runtime.js";

function fakeDeps(captured: Record<string, unknown>) {
  return {
    createAgentSessionServices: async (opts: Record<string, unknown>) => {
      captured.servicesOptions = opts;
      return { diagnostics: [], modelRuntime: opts.modelRuntime };
    },
    createAgentSessionFromServices: async () => ({ session: {} }),
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
