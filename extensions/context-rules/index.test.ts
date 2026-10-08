import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: vi.fn(),
}));

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import contextRules from "./index.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
let agentDir = "";
let cwd = "";

function setup(): Handler {
  const handlers = new Map<string, Handler>();
  contextRules({ on: (event: string, handler: Handler) => handlers.set(event, handler) } as never);
  return handlers.get("before_agent_start")!;
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
});

describe("context-rules before_agent_start", () => {
  it("把启用的规则追加到 contextFiles，原有条目保留", async () => {
    const event = { systemPromptOptions: { cwd, contextFiles: [{ path: "/AGENTS.md", content: "a" }] } };
    expect(await setup()(event, { cwd })).toBeUndefined();
    expect(event.systemPromptOptions.contextFiles).toEqual([
      { path: "/AGENTS.md", content: "a" },
      { path: join(agentDir, "rules", "zh.md"), content: "用中文" },
    ]);
  });

  it("没有启用的规则时不动 contextFiles", async () => {
    writeFileSync(join(agentDir, "rules", "zh.md"), "---\nenabled: false\n---\n用中文");
    const contextFiles = [{ path: "/AGENTS.md", content: "a" }];
    const event = { systemPromptOptions: { cwd, contextFiles } };
    await setup()(event, { cwd });
    expect(event.systemPromptOptions.contextFiles).toBe(contextFiles);
  });
});
