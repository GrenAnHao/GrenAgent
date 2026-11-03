import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: vi.fn(),
}));

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { __resetAgentModeForTest, setAgentMode } from "../agent-mode/modes.js";
import contextRules from "./index.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
let agentDir = "";
let cwd = "";

function setup(): Handler {
  const handlers = new Map<string, Handler>();
  contextRules({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as never);
  return handlers.get("before_agent_start")!;
}

function options() {
  return { cwd, contextFiles: [{ path: "/AGENTS.md", content: "a" }] };
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "rules-agent-"));
  cwd = mkdtempSync(join(tmpdir(), "rules-ws-"));
  mkdirSync(join(agentDir, "rules"));
  mkdirSync(join(cwd, ".pi", "rules"), { recursive: true });
  writeFileSync(join(agentDir, "rules", "zh.md"), "---\ntitle: 中文\n---\n用中文");
  writeFileSync(join(cwd, ".pi", "rules", "pnpm.md"), "---\ntitle: pnpm\nenabled: false\n---\n用 pnpm");
  vi.mocked(getAgentDir).mockReturnValue(agentDir);
  vi.spyOn(console, "error").mockImplementation(() => {});
  __resetAgentModeForTest();
});

describe("context-rules before_agent_start", () => {
  it("把启用的规则追加到 contextFiles，原有条目保留", async () => {
    const event = { systemPromptOptions: options() };
    expect(await setup()(event, { cwd })).toBeUndefined();
    expect(event.systemPromptOptions.contextFiles).toEqual([
      { path: "/AGENTS.md", content: "a" },
      { path: join(agentDir, "rules", "zh.md"), content: "用中文" },
    ]);
  });

  it("不删除其它来源的 rules 目录上下文文件", async () => {
    const file = { path: join(cwd, "docs", "rules", "AGENTS.md"), content: "Keep permission constraints" };
    const event = { systemPromptOptions: { cwd, contextFiles: [file] } };
    await setup()(event, { cwd });
    expect(event.systemPromptOptions.contextFiles).toContainEqual(file);
  });

  it("没有启用的规则时不动 contextFiles", async () => {
    writeFileSync(join(agentDir, "rules", "zh.md"), "---\nenabled: false\n---\n用中文");
    const contextFiles = [{ path: "/AGENTS.md", content: "a" }];
    const event = { systemPromptOptions: { cwd, contextFiles } };
    await setup()(event, { cwd });
    expect(event.systemPromptOptions.contextFiles).toBe(contextFiles);
  });

  it("模式专属规则只在对应模式注入，普通模式看不到", async () => {
    writeFileSync(join(agentDir, "rules", "ultra.md"), "---\ntitle: U\nmodes: [ultra]\n---\n用多代理");
    writeFileSync(join(agentDir, "rules", "plan.md"), "---\ntitle: P\nmodes: [plan]\n---\n先规划");

    const ultra = { systemPromptOptions: options() };
    setAgentMode("ultra", cwd);
    await setup()(ultra, { cwd });
    // 规则按文件 id 排序：plan.md < ultra.md < zh.md
    expect(ultra.systemPromptOptions.contextFiles.map((f) => f.content)).toEqual(["a", "用多代理", "用中文"]);

    const agent = { systemPromptOptions: options() };
    setAgentMode("agent", cwd);
    await setup()(agent, { cwd });
    expect(agent.systemPromptOptions.contextFiles.map((f) => f.content)).toEqual(["a", "用中文"]);

    const plan = { systemPromptOptions: options() };
    setAgentMode("plan", cwd);
    await setup()(plan, { cwd });
    expect(plan.systemPromptOptions.contextFiles.map((f) => f.content)).toEqual(["a", "先规划", "用中文"]);
  });

  it("无 ALS 时优先按 SDK 当前会话身份过滤，不误用项目默认", async () => {
    writeFileSync(join(agentDir, "rules", "ultra.md"), "---\nmodes: [ultra]\n---\nUltra only");
    setAgentMode("ask", cwd);
    setAgentMode("ultra", cwd, "ultra-session");
    const event = { systemPromptOptions: options() };
    await setup()(event, { cwd, sessionManager: { getSessionId: () => "ultra-session" } });
    expect(event.systemPromptOptions.contextFiles.map((file) => file.content)).toContain("Ultra only");
  });

  it("切出 Ultra 后同一轮对象上不残留 Ultra 专属规则", async () => {
    writeFileSync(join(agentDir, "rules", "ultra.md"), "---\nmodes: [ultra]\n---\n用多代理");
    const event = { systemPromptOptions: options() };
    setAgentMode("ultra", cwd);
    await setup()(event, { cwd });
    expect(event.systemPromptOptions.contextFiles.map((f) => f.content)).toContain("用多代理");

    setAgentMode("agent", cwd);
    await setup()(event, { cwd });
    expect(event.systemPromptOptions.contextFiles.map((f) => f.content)).not.toContain("用多代理");
  });

  it("旧规则（无 modes）在任何模式下都注入", async () => {
    for (const mode of ["agent", "ask", "debug", "plan", "ultra"] as const) {
      setAgentMode(mode, cwd);
      const event = { systemPromptOptions: options() };
      await setup()(event, { cwd });
      expect(event.systemPromptOptions.contextFiles.map((f) => f.content)).toContain("用中文");
    }
  });
});
