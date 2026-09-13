import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SubAgentRegistry } from "./registry.js";
import * as parentHost from "./parent-host.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* sqlite / session file handle may linger on Windows */
    }
  }
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sa-reap-"));
  dirs.push(dir);
  return dir;
}

function registry(): SubAgentRegistry {
  const r = new SubAgentRegistry(join(tmpDir(), "registry.db"));
  r.load();
  return r;
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

function writeMeta(cwd: string, id: string, data: Record<string, unknown>, extra?: Record<string, unknown>[]): string {
  const sm = SessionManager.create(cwd, join(cwd, "sessions"), { id });
  if (extra) {
    for (const item of extra) sm.appendCustomEntry("subagent_meta", item);
  }
  sm.appendCustomEntry("subagent_meta", data);
  return persistSession(sm);
}

describe("reapOrphans · continuable leftover", () => {
  it("marks continuable leftover as done without notifying the parent model", () => {
    const cwd = tmpDir();
    const sessionPath = writeMeta(cwd, "sa-cont01", { mode: "continuable" });
    const r = new SubAgentRegistry(join(cwd, "registry.db"));
    r.load();
    r.create({ id: "sa-cont01", task: "t", sessionPath });
    const send = vi.spyOn(parentHost, "sendSettlementToParent");

    const n = r.reapOrphans();
    const row = r.get("sa-cont01");
    expect(n).toBe(1);
    expect(row?.status).toBe("done");
    expect(row?.error).toBe("sidecar restarted");
    expect(row?.output).toBe("");
    expect(send).toHaveBeenCalledTimes(0);
    r.close();
  });

  it("uses the last subagent_meta when deciding leftover mode", () => {
    const cwd = tmpDir();
    const sessionPath = writeMeta(cwd, "sa-last01", { mode: "continuable" }, [{ mode: "one-shot" }]);
    const r = new SubAgentRegistry(join(cwd, "registry.db"));
    r.load();
    r.create({ id: "sa-last01", task: "t", sessionPath });

    r.reapOrphans();
    expect(r.get("sa-last01")?.status).toBe("done");
    expect(r.get("sa-last01")?.error).toBe("sidecar restarted");
    r.close();
  });

  it("marks empty sessionPath as orphaned", () => {
    const r = registry();
    r.create({ id: "sa-empty01", task: "t", sessionPath: "" });
    r.reapOrphans();
    expect(r.get("sa-empty01")?.status).toBe("error");
    expect(r.get("sa-empty01")?.error).toContain("orphaned");
    r.close();
  });

  it("marks missing jsonl as orphaned", () => {
    const cwd = tmpDir();
    const r = new SubAgentRegistry(join(cwd, "registry.db"));
    r.load();
    r.create({ id: "sa-miss01", task: "t", sessionPath: join(cwd, "no-such.jsonl") });
    r.reapOrphans();
    expect(r.get("sa-miss01")?.status).toBe("error");
    expect(r.get("sa-miss01")?.error).toContain("orphaned");
    r.close();
  });

  it("marks one-shot leftover as orphaned", () => {
    const cwd = tmpDir();
    const sessionPath = writeMeta(cwd, "sa-one001", { mode: "one-shot" });
    const r = new SubAgentRegistry(join(cwd, "registry.db"));
    r.load();
    r.create({ id: "sa-one001", task: "t", sessionPath });
    r.reapOrphans();
    expect(r.get("sa-one001")?.status).toBe("error");
    expect(r.get("sa-one001")?.error).toContain("orphaned");
    r.close();
  });

  it("marks tornDown leftover as orphaned", () => {
    const cwd = tmpDir();
    const sessionPath = writeMeta(cwd, "sa-tear01", { mode: "continuable", tornDown: true });
    const r = new SubAgentRegistry(join(cwd, "registry.db"));
    r.load();
    r.create({ id: "sa-tear01", task: "t", sessionPath });
    r.reapOrphans();
    expect(r.get("sa-tear01")?.status).toBe("error");
    expect(r.get("sa-tear01")?.error).toContain("orphaned");
    r.close();
  });

  it("marks a session that cannot be opened as orphaned", () => {
    const cwd = tmpDir();
    const sessionPath = join(cwd, "broken.jsonl");
    writeFileSync(sessionPath, "not a pi session\n");
    const r = new SubAgentRegistry(join(cwd, "registry.db"));
    r.load();
    r.create({ id: "sa-bad0001", task: "t", sessionPath });
    r.reapOrphans();
    expect(r.get("sa-bad0001")?.status).toBe("error");
    expect(r.get("sa-bad0001")?.error).toContain("orphaned");
    r.close();
  });
});
