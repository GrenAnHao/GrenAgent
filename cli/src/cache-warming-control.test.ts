import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";
import { attachCacheWarmingControl } from "./cache-warming-control.js";

test("热更新现读 SDK 全局设置，调用官方会话 setter；关闭后取消预热，dispose 退订", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cache-control-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const path = join(agentDir, "settings.json");
  await writeFile(path, JSON.stringify({ cacheWarming: "idle", unrelated: true }));
  const settingsManager = SettingsManager.create(root, agentDir);
  const { CacheWarmer } = await import(new URL("./core/cache-warmer.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  const warmer = new CacheWarmer({ streamSimple() { throw new Error("remote request forbidden"); } }, { getBranch: () => [{ type: "message", message: { role: "assistant", usage: { input: 100000, cacheRead: 0, cacheWrite: 0 } } }] }, () => settingsManager.getCacheWarmingMode());
  const session = {
    settingsManager,
    _cacheWarmer: warmer,
    setCacheWarmingMode: AgentSession.prototype.setCacheWarmingMode,
    dispose() { warmer.cancel(); },
  };
  let callback = () => {};
  let unsubscribed = false;
  attachCacheWarmingControl(session, root, agentDir, (cb) => { callback = cb; return () => { unsubscribed = true; }; });
  try {
    assert.equal(settingsManager.getCacheWarmingMode(), "idle");
    // 排程由真实 SDK CacheWarmer 建立；测试在计时触发前切换，不发请求。
    const request = { model: { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-4", promptCache: { short: 300 }, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, context: { messages: [] }, options: { cacheRetention: "short" } };
    warmer.start(request, () => true);
    assert.equal(warmer.status.state, "scheduled");
    const controller = warmer.run.controller;
    await writeFile(path, JSON.stringify({ cacheWarming: "off", unrelated: true }));
    callback();
    assert.equal(settingsManager.getCacheWarmingMode(), "off");
    assert.equal(warmer.status.state, "inactive");
    assert.equal(warmer.run, undefined);
    assert.equal(controller.signal.aborted, true);
    await settingsManager.flush();
    assert.equal(JSON.parse(await readFile(path, "utf8")).unrelated, true);
    for (const mode of ["streaming", "idle"] as const) {
      await writeFile(path, JSON.stringify({ cacheWarming: mode }));
      callback();
      assert.equal(settingsManager.getCacheWarmingMode(), mode);
      await settingsManager.flush();
    }
    warmer.start(request, () => true);
    warmer.onAgentSettled();
    assert.equal(warmer.run.phase, 'idle');
    await writeFile(path, JSON.stringify({ cacheWarming: 'streaming' }));
    callback();
    assert.equal(warmer.run, undefined, 'idle → streaming 必须取消已有空闲预热');
    session.dispose();
    assert.equal(unsubscribed, true);
  } finally {
    session.dispose();
    await settingsManager.flush();
    await rm(root, { recursive: true, force: true });
  }
});

test("未发生配置修改时不把 SDK 缺省写进 settings.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cache-default-"));
  let changes = 0;
  const manager = SettingsManager.create(root, root);
  const session = { settingsManager: manager, setCacheWarmingMode: () => { changes++; }, dispose() {} };
  let callback = () => {};
  attachCacheWarmingControl(session, root, root, (cb) => { callback = cb; return () => {}; });
  callback();
  assert.equal(changes, 0);
  await assert.rejects(readFile(join(root, "settings.json")), { code: "ENOENT" });
  session.dispose();
  await rm(root, { recursive: true, force: true });
});
