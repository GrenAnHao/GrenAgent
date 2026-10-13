import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn((_k: string): string | undefined => undefined),
  getApprovalPolicy: vi.fn(() => "auto"),
}));
vi.mock("../_shared/runtime-config.js", () => ({ getConfig: mocks.getConfig }));
vi.mock("../_shared/approval.js", () => ({ getApprovalPolicy: mocks.getApprovalPolicy }));

import { __resetSessionCwdForTest, attachSessionCwd } from "../_shared/session-cwd.js";
import workingDirectory from "./index.js";

type Tool = {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean }>;
};

let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function load() {
  const tools: Record<string, Tool> = {};
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  workingDirectory({
    registerTool: (t: Tool) => (tools[t.name] = t),
    on: (name: string, h: (event: unknown, ctx: unknown) => unknown) => (handlers[name] = h),
  } as never);
  return { tools, handlers };
}

function session(id: string, original: string) {
  const entries: unknown[] = [];
  const runner = { cwd: original };
  const s = {
    sessionId: id,
    extensionRunner: runner,
    sessionManager: {
      getCwd: () => original,
      getEntries: () => entries,
      appendCustomEntry: (customType: string, data?: unknown) => entries.push({ type: "custom", customType, data }),
      getSessionId: () => id,
    },
  };
  attachSessionCwd(s);
  const ctx = {
    get cwd() {
      return runner.cwd;
    },
    sessionManager: s.sessionManager,
  };
  return { runner, entries, ctx };
}

beforeEach(() => {
  __resetSessionCwdForTest();
  mocks.getConfig.mockReset().mockReturnValue(undefined);
  mocks.getApprovalPolicy.mockReset().mockReturnValue("auto");
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), "wd-tool-")));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "AGENTS.md"), "root instructions\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("working-directory tools", { timeout: 30_000 }, () => {
  it("register with Available-tools snippets and guidelines that name the tool", () => {
    const { tools } = load();
    for (const name of ["working_directory", "create_worktree"]) {
      expect(tools[name]?.promptSnippet).toBeTruthy();
      for (const g of tools[name]?.promptGuidelines ?? []) expect(g).toContain(name);
    }
  });

  it("working_directory reads, changes and refuses missing directories", async () => {
    mkdirSync(join(repo, "sub"));
    const { tools } = load();
    const { runner, ctx } = session("s1", repo);
    const read = await tools.working_directory!.execute("t", {}, undefined, undefined, ctx);
    expect(read.content[0]!.text).toBe(repo);
    const moved = await tools.working_directory!.execute("t", { cd: "sub" }, undefined, undefined, ctx);
    expect(moved.details).toMatchObject({ changed: true, previous: repo, original: repo });
    expect(runner.cwd.toLowerCase()).toBe(join(repo, "sub").toLowerCase());
    const missing = await tools.working_directory!.execute("t", { cd: "nope" }, undefined, undefined, ctx);
    expect(missing.isError).toBe(true);
  });

  it("create_worktree builds the checkout and moves only the calling session; leaving keeps it", async () => {
    const { tools } = load();
    const main = session("main", repo);
    const other = session("other", repo);
    const r = await tools.create_worktree!.execute("t", { name: "feat" }, undefined, undefined, main.ctx);
    expect(r.isError).toBeUndefined();
    const path = join(repo, ".agents", "worktrees", "feat");
    expect(String(r.details.path).toLowerCase()).toBe(path.toLowerCase());
    expect(main.runner.cwd.toLowerCase()).toBe(path.toLowerCase());
    expect(other.runner.cwd).toBe(repo);
    expect(r.content[0]!.text).toContain("Existing MCP servers");
    const back = await tools.working_directory!.execute("t", { cd: repo }, undefined, undefined, main.ctx);
    expect(back.details.changed).toBe(true);
    expect(git(repo, "branch", "--list", "feat")).toContain("feat");
  });

  it("create_worktree is refused in a read-only session and when no controller is attached", async () => {
    const { tools } = load();
    const { ctx } = session("ro", repo);
    mocks.getConfig.mockImplementation((k) => (k === "SAFETY_READONLY" ? "1" : undefined));
    expect((await tools.create_worktree!.execute("t", {}, undefined, undefined, ctx)).isError).toBe(true);
    mocks.getConfig.mockReturnValue(undefined);
    mocks.getApprovalPolicy.mockReturnValue("readonly");
    expect((await tools.create_worktree!.execute("t", {}, undefined, undefined, ctx)).isError).toBe(true);
    const orphan = { cwd: repo, sessionManager: { getSessionId: () => "nobody", getCwd: () => repo } };
    const r = await tools.working_directory!.execute("t", {}, undefined, undefined, orphan);
    expect(r.isError).toBe(true);
  });

  it("before_agent_start re-reads project instructions from the current directory only after a move", async () => {
    const { handlers } = load();
    const sub = join(repo, "pkg");
    mkdirSync(sub);
    writeFileSync(join(sub, "AGENTS.md"), "package instructions\n");
    const { runner, ctx } = session("s5", repo);
    const event = { systemPromptOptions: { cwd: repo, contextFiles: [{ path: "old", content: "old" }] } };
    handlers.before_agent_start!(event, ctx);
    expect(event.systemPromptOptions.contextFiles).toEqual([{ path: "old", content: "old" }]);
    runner.cwd = sub;
    handlers.before_agent_start!(event, ctx);
    const contents = event.systemPromptOptions.contextFiles.map((f) => f.content);
    expect(contents).toContain("package instructions\n");
    expect(event.systemPromptOptions.cwd).toBe(sub);
    mocks.getConfig.mockImplementation((k) => (k === "PI_DISABLE_PROJECT_CONTEXT" ? "1" : undefined));
    const untouched = { systemPromptOptions: { cwd: repo, contextFiles: [] as unknown[] } };
    handlers.before_agent_start!(untouched, ctx);
    expect(untouched.systemPromptOptions.contextFiles).toEqual([]);
  });
});
