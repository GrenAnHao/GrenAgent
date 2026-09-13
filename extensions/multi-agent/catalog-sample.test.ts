import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { installActivation, __resetActivationsForTest } from "./activation.js";
import { sampleCatalogRow, type CatalogRowView } from "./catalog-sample.js";
import type { SubagentCatalogEntry } from "./catalog.js";

const dirs: string[] = [];

afterEach(() => {
  __resetActivationsForTest();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* session file handle may linger on Windows */
    }
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cat-sample-"));
  dirs.push(dir);
  return dir;
}

function persistSession(sm: SessionManager): string {
  const path = sm.getSessionFile();
  if (!path) throw new Error("session file was not created");
  // SessionManager 在没有 assistant 消息时不落盘 header/custom，测试必须自己写出 JSONL。
  const header = sm.getHeader();
  const lines = [header, ...sm.getEntries()].filter(Boolean).map((entry) => JSON.stringify(entry));
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function usage(n: number) {
  return {
    input: n,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: n,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(n: number, timestamp = 1) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "ok" }],
    api: "openai-completions" as const,
    provider: "openai" as const,
    model: "gpt",
    usage: usage(n),
    stopReason: "stop" as const,
    timestamp,
  };
}

function writeChild(over: {
  tornDown?: boolean;
  inheritedEventCount?: number;
  messages?: Parameters<SessionManager["appendMessage"]>[0][];
  catalog?: Record<string, unknown>[];
} = {}): string {
  const dir = tmpDir();
  const sm = SessionManager.create("/ws", dir);
  sm.appendCustomEntry("subagent_meta", {
    mode: "continuable",
    tornDown: over.tornDown === true,
    inheritedEventCount: over.inheritedEventCount ?? 0,
  });
  for (const message of over.messages ?? []) {
    sm.appendMessage(message);
  }
  for (const fact of over.catalog ?? []) {
    sm.appendCustomEntry("subagent_catalog", fact);
  }
  return persistSession(sm);
}

function entry(sessionPath: string, over: Partial<SubagentCatalogEntry> = {}): SubagentCatalogEntry {
  return {
    id: "sa-1",
    sessionPath,
    createdAt: 100,
    mode: "one-shot",
    label: "first",
    ...over,
  };
}

function mockSession(over: { isStreaming?: boolean; isCompacting?: boolean } = {}) {
  return {
    isStreaming: over.isStreaming === true,
    isCompacting: over.isCompacting === true,
    pendingMessageCount: 0,
    messages: [] as unknown[],
    prompt: () => {},
    abort: async () => {},
    dispose: () => {},
    waitForIdle: async () => {},
  };
}

function installResident(sessionPath: string, over: { isStreaming?: boolean; isCompacting?: boolean } = {}) {
  installActivation({
    childId: "sa-1",
    sessionPath,
    parentSessionId: "p1",
    parentSessionPath: "/ws/parent.jsonl",
    workspace: "/ws",
    session: mockSession(over),
    announced: false,
  });
}

function sample(sessionPath: string, over: Partial<SubagentCatalogEntry> = {}, opts?: { now?: number }): CatalogRowView {
  return sampleCatalogRow(entry(sessionPath, over), opts);
}

describe("sampleCatalogRow", () => {
  it("one-shot file present is settled not unavailable", () => {
    const sessionPath = writeChild();
    const row = sample(sessionPath, { mode: "one-shot" });
    expect(row.activity).toBe("settled");
    expect(row.diagnostic).toBeUndefined();
  });

  it("continuable without activation is ready", () => {
    const sessionPath = writeChild();
    expect(sample(sessionPath, { mode: "continuable" }).activity).toBe("ready");
  });

  it("resident streaming is running", () => {
    const sessionPath = writeChild();
    installResident(sessionPath, { isStreaming: true });
    expect(sample(sessionPath, { mode: "continuable" }).activity).toBe("running");
  });

  it("omits tokens when no usage", () => {
    const sessionPath = writeChild({
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    expect(sample(sessionPath).tokens).toBeUndefined();
  });

  it("slices inheritedEventCount for tokens", () => {
    const sessionPath = writeChild({
      inheritedEventCount: 2,
      messages: [assistant(100), assistant(200), assistant(5)],
    });
    expect(sample(sessionPath).tokens).toBe(5);
  });

  it("continuable tornDown is settled", () => {
    const sessionPath = writeChild({ tornDown: true });
    expect(sample(sessionPath, { mode: "continuable" }).activity).toBe("settled");
  });

  it("missing file is unavailable", () => {
    const sessionPath = join(tmpDir(), "missing.jsonl");
    const row = sample(sessionPath, { mode: "continuable" });
    expect(row.activity).toBe("unavailable");
    expect(row.diagnostic).toBe("unavailable");
  });

  it("resident idle is idle", () => {
    const sessionPath = writeChild();
    installResident(sessionPath, { isStreaming: false });
    expect(sample(sessionPath, { mode: "continuable" }).activity).toBe("idle");
  });

  it("hasChildren when child file has catalog facts", () => {
    const sessionPath = writeChild({
      catalog: [
        {
          version: 0,
          childId: "sa-g",
          sessionPath: "/c/g.jsonl",
          childCreatedAt: 1,
          mode: "one-shot",
          label: "g",
        },
      ],
    });
    expect(sample(sessionPath).hasChildren).toBe(true);
  });

  it("durationMs is last assistant minus first user after slice", () => {
    const sessionPath = writeChild({
      messages: [
        { role: "user", content: "hi", timestamp: 1000 },
        assistant(1, 4000),
      ],
    });
    expect(sample(sessionPath).durationMs).toBe(3000);
  });

  it("running durationMs uses opts.now as the end", () => {
    const sessionPath = writeChild({
      messages: [{ role: "user", content: "hi", timestamp: 1000 }],
    });
    installResident(sessionPath, { isStreaming: true });
    expect(sample(sessionPath, { mode: "continuable" }, { now: 9000 }).durationMs).toBe(8000);
  });

  it("omits durationMs when messages have no timestamps", () => {
    const sessionPath = writeChild({
      messages: [
        { role: "user", content: "hi" } as never,
        { ...assistant(1), timestamp: undefined } as never,
      ],
    });
    expect(sample(sessionPath).durationMs).toBeUndefined();
  });

  it("slices inheritedEventCount out of durationMs", () => {
    const sessionPath = writeChild({
      inheritedEventCount: 1,
      messages: [
        { role: "user", content: "seed", timestamp: 1 },
        assistant(9, 2),
        { role: "user", content: "own", timestamp: 100 },
        assistant(1, 400),
      ],
    });
    expect(sample(sessionPath).durationMs).toBe(300);
  });
});
