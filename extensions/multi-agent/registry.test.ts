import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "../_shared/sqlite.js";
import { SubAgentRegistry } from "./registry.js";
import { LIVE_TRANSCRIPT_TAIL } from "./transcript-tail.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function reg(): SubAgentRegistry {
  const dir = mkdtempSync(join(tmpdir(), "sa-reg-"));
  dirs.push(dir);
  const r = new SubAgentRegistry(join(dir, "registry.db"));
  r.load();
  return r;
}

describe("SubAgentRegistry", () => {
  it("create → get returns a running row", () => {
    const r = reg();
    const id = SubAgentRegistry.genId();
    r.create({ id, task: "do x", model: "m1" });
    const row = r.get(id);
    expect(row?.status).toBe("running");
    expect(row?.task).toBe("do x");
    expect(row?.model).toBe("m1");
    r.close();
  });

  it("finish updates status/output/exitCode", () => {
    const r = reg();
    const id = SubAgentRegistry.genId();
    r.create({ id, task: "t" });
    r.finish(id, { status: "done", output: "result", exitCode: 0 });
    const row = r.get(id);
    expect(row?.status).toBe("done");
    expect(row?.output).toBe("result");
    expect(row?.exitCode).toBe(0);
    r.close();
  });

  it("list returns rows", () => {
    const r = reg();
    r.create({ id: "sa-aaaaaaaa", task: "a" });
    r.create({ id: "sa-bbbbbbbb", task: "b" });
    const ids = r.list().map((x) => x.id);
    expect(ids).toContain("sa-aaaaaaaa");
    expect(ids).toContain("sa-bbbbbbbb");
    r.close();
  });

  it("genId has sa- prefix and is unique", () => {
    expect(SubAgentRegistry.genId()).toMatch(/^sa-[0-9a-f]{8}$/);
    expect(SubAgentRegistry.genId()).not.toBe(SubAgentRegistry.genId());
  });

  it("stores sessionPath when provided", () => {
    const r = reg();
    r.create({ id: "sa-1", task: "t", sessionPath: "/ws/sa-1.jsonl" });
    expect(r.get("sa-1")?.sessionPath).toBe("/ws/sa-1.jsonl");
    r.close();
  });

  it("reapOrphans marks leftover running rows as error", () => {
    const r = reg();
    r.create({ id: "sa-orphan00", task: "t" });
    const n = r.reapOrphans();
    expect(n).toBe(1);
    expect(r.get("sa-orphan00")?.status).toBe("error");
    expect(r.get("sa-orphan00")?.error).toContain("orphaned");
    r.close();
  });

  it("touch keeps a running row running", () => {
    const r = reg();
    r.create({ id: "sa-touch001", task: "t" });
    r.touch("sa-touch001");
    expect(r.get("sa-touch001")?.status).toBe("running");
    r.close();
  });

  it("findStuck returns running rows older than threshold, ignores terminal", () => {
    const r = reg();
    r.create({ id: "sa-stuck001", task: "t" });
    expect(r.findStuck(0).map((x) => x.id)).toContain("sa-stuck001");
    expect(r.findStuck(100000)).toEqual([]);
    r.finish("sa-stuck001", { status: "done" });
    expect(r.findStuck(0)).toEqual([]);
    r.close();
  });

  it("remove deletes a record (idempotent)", () => {
    const r = reg();
    r.create({ id: "sa-rm000001", task: "t" });
    expect(r.remove("sa-rm000001")).toBe(true);
    expect(r.get("sa-rm000001")).toBeUndefined();
    expect(r.remove("sa-rm000001")).toBe(false);
    r.close();
  });

  it("progress writes transcript and keeps the row running", () => {
    const r = reg();
    r.create({ id: "sa-prog0001", task: "t" });
    r.progress("sa-prog0001", '{"type":"message_update"}');
    const row = r.get("sa-prog0001");
    expect(row?.status).toBe("running");
    expect(row?.transcript).toBe('{"type":"message_update"}');
    r.close();
  });

  it("progress throttles rapid writes: first frame persists, an immediate second is skipped", () => {
    // 落盘节流（PROGRESS_PERSIST_MS）：流式高频帧不应每帧都同步写 SQLite。首帧立即落盘，
    // 紧接着 <1s 的第二帧被跳过（transcript 是累计量，下次到点再写即最新）。
    const r = reg();
    r.create({ id: "sa-thr00001", task: "t" });
    r.progress("sa-thr00001", "first");
    r.progress("sa-thr00001", "second");
    expect(r.get("sa-thr00001")?.transcript).toBe("first");
    r.close();
  });

  it("finish persists the final transcript", () => {
    const r = reg();
    r.create({ id: "sa-fin00001", task: "t" });
    r.finish("sa-fin00001", { status: "done", output: "out", exitCode: 0, transcript: "LINE1\nLINE2" });
    expect(r.get("sa-fin00001")?.transcript).toBe("LINE1\nLINE2");
    r.close();
  });

  it("finish without transcript keeps the streamed transcript (COALESCE)", () => {
    const r = reg();
    r.create({ id: "sa-coal0001", task: "t" });
    r.progress("sa-coal0001", "streamed");
    r.finish("sa-coal0001", { status: "done", output: "out", exitCode: 0 });
    const row = r.get("sa-coal0001");
    expect(row?.status).toBe("done");
    expect(row?.transcript).toBe("streamed");
    r.close();
  });

  it("progress is a no-op after finish (running guard)", () => {
    const r = reg();
    r.create({ id: "sa-guard001", task: "t" });
    r.finish("sa-guard001", { status: "done", output: "out", exitCode: 0, transcript: "final" });
    r.progress("sa-guard001", "late");
    expect(r.get("sa-guard001")?.transcript).toBe("final");
    r.close();
  });

  it("progress truncates an oversized transcript to the live tail cap", () => {
    const r = reg();
    r.create({ id: "sa-trunc001", task: "t" });
    r.progress("sa-trunc001", "x\n".repeat(LIVE_TRANSCRIPT_TAIL)); // 约 2x 上限，远超
    const len = r.get("sa-trunc001")?.transcript?.length ?? 0;
    expect(len).toBeGreaterThan(0);
    expect(len).toBeLessThanOrEqual(LIVE_TRANSCRIPT_TAIL);
    r.close();
  });

  it("finish with empty transcript keeps the streamed transcript (empty treated as no-op)", () => {
    const r = reg();
    r.create({ id: "sa-empty001", task: "t" });
    r.progress("sa-empty001", "kept");
    r.finish("sa-empty001", { status: "done", output: "out", exitCode: 0, transcript: "" });
    expect(r.get("sa-empty001")?.transcript).toBe("kept");
    r.close();
  });

  it("migrates an old db without parentId/depth and persists them on create", () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-reg-mig-"));
    dirs.push(dir);
    const file = join(dir, "registry.db");
    const raw = new DatabaseSync(file);
    raw.exec(
      `CREATE TABLE subagents (id TEXT PRIMARY KEY, task TEXT NOT NULL, profile TEXT, model TEXT, status TEXT NOT NULL, output TEXT, error TEXT, exitCode INTEGER, transcript TEXT, sessionPath TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
    );
    raw.close();
    const reg = new SubAgentRegistry(file);
    reg.load();
    const row = reg.create({ id: "sa-n", task: "t", parentId: "sa-p", depth: 2 });
    expect(row.parentId).toBe("sa-p");
    expect(row.depth).toBe(2);
    expect(reg.get("sa-n")).toMatchObject({ parentId: "sa-p", depth: 2 });
    reg.close();
  });

  it("defaults parentId null / depth 0", () => {
    const r = reg();
    expect(r.create({ id: "sa-0", task: "t" })).toMatchObject({ parentId: null, depth: 0 });
    r.close();
  });
});
