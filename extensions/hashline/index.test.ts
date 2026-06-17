import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import hashline from "./index.js";

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal: AbortSignal | null,
  onUpdate: null,
  ctx: { cwd: string },
) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;

// 加载扩展并返回同一实例的工具（共享内部 snapshots closure）。
function load(): Record<string, Execute> {
  const tools: Record<string, Execute> = {};
  const pi = {
    registerTool(tool: { name: string; execute: Execute }) {
      tools[tool.name] = tool.execute;
    },
  };
  hashline(pi as unknown as Parameters<typeof hashline>[0]);
  return tools;
}

function text(r: { content: Array<{ text: string }> }): string {
  return r.content[0].text;
}

function setup(content: string): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "hl-rec-"));
  const file = join(root, "a.ts");
  writeFileSync(file, content);
  return { root, file };
}

describe("hashline auto-recovery (integration)", () => {
  it("recovers stale tag when unrelated lines changed", async () => {
    const { root, file } = setup("a\nb\nc\n");
    const tools = load();
    const ctx = { cwd: root };
    const read = text(await tools.hl_read("1", { path: "a.ts" }, null, null, ctx));
    const tag = read.match(/#([0-9a-f]{4})\]/)?.[1];
    writeFileSync(file, "HEADER\na\nb\nc\n"); // 无关改动（开头插一行）
    const edit = text(await tools.hl_edit("2", { patch: `[a.ts#${tag}]\nSWAP 2:\n+B` }, null, null, ctx));
    expect(edit).toContain("自动恢复");
    expect(readFileSync(file, "utf8")).toBe("HEADER\na\nB\nc\n");
  });

  it("rejects when the target line changed (conflict)", async () => {
    const { root, file } = setup("a\nb\nc\n");
    const tools = load();
    const ctx = { cwd: root };
    const read = text(await tools.hl_read("1", { path: "a.ts" }, null, null, ctx));
    const tag = read.match(/#([0-9a-f]{4})\]/)?.[1];
    writeFileSync(file, "a\nXXX\nc\n"); // 目标行被改
    const edit = text(await tools.hl_edit("2", { patch: `[a.ts#${tag}]\nSWAP 2:\n+B` }, null, null, ctx));
    expect(edit).toContain("被拒绝");
    expect(readFileSync(file, "utf8")).toBe("a\nXXX\nc\n");
  });

  it("rejects a stale tag when no snapshot exists", async () => {
    const { root, file } = setup("a\nb\n");
    const tools = load();
    const ctx = { cwd: root };
    const edit = text(await tools.hl_edit("2", { patch: "[a.ts#ffff]\nSWAP 1:\n+X" }, null, null, ctx));
    expect(edit).toContain("无可用快照");
    expect(readFileSync(file, "utf8")).toBe("a\nb\n");
  });
});
