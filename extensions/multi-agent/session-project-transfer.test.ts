// 会话族迁移的子代理适配层定向测试：记录级 registry 差异、闭包、结算保护、
// 活动检查与只释放已结算驻留会话。不跑真实用户会话，不请求模型。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "../_shared/sqlite.js";
import { sha256Text, stableJson as coreStableJson } from "../../electron-agent/electron/app/sessionProjectTransferJournal.js";
import { SubAgentRegistry } from "./registry.js";
import {
  TransferRegistryConflictError,
  applyTransferRegistryDiff,
  checkTransferFamilyActivity,
  descendantsInRegistry,
  drainTransferFamily,
  isSettledTransferRegistryRow,
  planTransferRegistry,
  readTransferRegistryRows,
  rollbackTransferRegistryDiff,
  snapshotTransferRegistryFamily,
  stableJson as adapterStableJson,
  transferRegistryRowEquals,
  transferRegistryRowsHash,
  transferRegistryRowsHashInReadOrder,
  transferActivityBusy,
  transferFamilyRefs,
  transferRegistryPort,
  type TransferRegistryDiff,
  type TransferRegistryRow,
} from "./session-project-transfer.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上 SQLite 句柄可能还留着 */
    }
  }
});

function tmp(prefix = "transfer-sa-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function row(over: Partial<TransferRegistryRow> & Pick<TransferRegistryRow, "id">): TransferRegistryRow {
  return {
    task: over.id,
    profile: null,
    model: null,
    thinkingLevel: null,
    status: "done",
    output: "done",
    error: null,
    exitCode: 0,
    transcript: "transcript",
    sessionPath: null,
    parentId: null,
    depth: 1,
    jobId: null,
    bashState: null,
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

function seed(workspace: string, rows: readonly TransferRegistryRow[]): void {
  const registry = new SubAgentRegistry(join(workspace, ".pi", "subagents", "registry.db"));
  registry.load();
  try {
    for (const item of rows) {
      registry.create({
        id: item.id,
        task: item.task,
        profile: item.profile,
        model: item.model,
        sessionPath: item.sessionPath,
        parentId: item.parentId,
        depth: item.depth,
        jobId: item.jobId,
      });
      registry.finish(item.id, {
        status: item.status as "done" | "error" | "cancelled",
        output: item.output,
        error: item.error,
        exitCode: item.exitCode,
        transcript: item.transcript,
        ...(item.bashState ? { bashState: JSON.parse(item.bashState) } : {}),
      });
      registry.setThinkingLevel(item.id, item.thinkingLevel ?? "");
    }
  } finally {
    registry.close();
  }
}

function readDb(workspace: string): DatabaseSync {
  return new DatabaseSync(join(workspace, ".pi", "subagents", "registry.db"));
}

/** 把读出的行原样写进另一个项目（模拟「目标项目本来就有相同记录」）。 */
function seedExact(workspace: string, rows: readonly TransferRegistryRow[]): void {
  mkdirSync(join(workspace, ".pi", "subagents"), { recursive: true });
  const db = readDb(workspace);
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS subagents (
         id TEXT PRIMARY KEY, task TEXT NOT NULL, profile TEXT, model TEXT, thinkingLevel TEXT,
         status TEXT NOT NULL, output TEXT, error TEXT, exitCode INTEGER, transcript TEXT,
         sessionPath TEXT, parentId TEXT, depth INTEGER NOT NULL DEFAULT 0, jobId TEXT,
         bashState TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
    );
    const stmt = db.prepare(
      "INSERT INTO subagents(id, task, profile, model, thinkingLevel, status, output, error, exitCode, transcript, sessionPath, parentId, depth, jobId, bashState, createdAt, updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const item of rows) {
      stmt.run(
        item.id, item.task, item.profile, item.model, item.thinkingLevel, item.status, item.output,
        item.error, item.exitCode, item.transcript, item.sessionPath, item.parentId, item.depth,
        item.jobId, item.bashState, item.createdAt, item.updatedAt,
      );
    }
  } finally {
    db.close();
  }
}

describe("transfer registry hash", () => {
  it("matches the frozen core journal hash for the same JSON rows", () => {
    const rows: TransferRegistryRow[] = [
      row({ id: "sa-2", createdAt: 2, status: "done" }),
      row({ id: "sa-1", createdAt: 1, status: "error", error: "boom", exitCode: -1, jobId: "j1" }),
    ];
    // core 的 diff 指纹：sha256Text(stableJson(rows))，rows 已按 id 排序。
    const coreSorted = [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    expect(adapterStableJson(rows)).toBe(coreStableJson(rows));
    expect(adapterStableJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(coreStableJson({ b: 1, a: [{ d: 2, c: 3 }] }));
    expect(transferRegistryRowsHash(rows)).toBe(sha256Text(coreStableJson(coreSorted)));
  });

  it("is order independent for the family fingerprint, while the target fingerprint keeps read order", () => {
    const a = row({ id: "sa-1", createdAt: 1 });
    const b = row({ id: "sa-2", createdAt: 2 });
    expect(transferRegistryRowsHash([a, b])).toBe(transferRegistryRowsHash([b, a]));
    // core 的 expectedTargetHash 是对「读出的 target 行」按 id 过滤后的数组指纹，保持读库顺序。
    expect(transferRegistryRowsHashInReadOrder([a, b])).not.toBe(transferRegistryRowsHashInReadOrder([b, a]));
    expect(transferRegistryRowsHashInReadOrder([a, b])).toBe(sha256Text(coreStableJson([a, b])));
  });
});

describe("read / closure", () => {
  it("reads every registry row without the UI limit and closes over parentId and child file session id", async () => {
    const workspace = tmp();
    const rows = Array.from({ length: 80 }, (_, index) =>
      row({ id: `sa-${String(index).padStart(3, "0")}`, parentId: "root", createdAt: index }),
    );
    rows.push(row({ id: "sa-grand", parentId: "sa-000", sessionPath: "/ws/s/2026-01-01T00-00-00-000Z_sa-000.jsonl" }));
    seed(workspace, rows);

    const all = await readTransferRegistryRows(workspace);
    expect(all).toHaveLength(81);

    const family = descendantsInRegistry(all, "root");
    // 80 个直接子 + 孙级（parentId 是子代理 id，且文件名里的 sessionId 也对上）。
    expect(family.map((item) => item.id)).toEqual(expect.arrayContaining(["sa-000", "sa-079", "sa-grand"]));

    const snapshot = await snapshotTransferRegistryFamily(workspace, "root");
    expect(snapshot.rows.map((item) => item.id)).toEqual([...snapshot.rows.map((item) => item.id)].sort());
    expect(snapshot.hash).toBe(transferRegistryRowsHash(snapshot.rows));
  });

  it("returns no rows for a project without a registry and does not create one", async () => {
    const workspace = tmp();
    expect(await readTransferRegistryRows(workspace)).toEqual([]);
    expect(await readTransferRegistryRows(join(workspace, "nested"))).toEqual([]);
    expect(() => readDb(workspace)).toThrow();
  });
});

describe("settlement guard", () => {
  it("rejects running rows and any unconfirmed background command stop", () => {
    expect(isSettledTransferRegistryRow(row({ id: "a", status: "running" }))).toBe(false);
    expect(isSettledTransferRegistryRow(row({
      id: "b",
      status: "running",
      bashState: JSON.stringify({ phase: "waiting-for-bash" }),
    }))).toBe(false);
    expect(isSettledTransferRegistryRow(row({
      id: "c",
      status: "error",
      bashState: JSON.stringify({
        reason: "background-bash-timeout", replyCompleted: true,
        jobs: [{ id: "j1", label: "serve", stopConfirmed: false }],
      }),
    }))).toBe(false);
    expect(isSettledTransferRegistryRow(row({
      id: "d",
      status: "error",
      bashState: JSON.stringify({
        reason: "background-bash-timeout", replyCompleted: true,
        jobs: [{ id: "j1", label: "serve", stopConfirmed: true }],
      }),
    }))).toBe(true);
    expect(isSettledTransferRegistryRow(row({ id: "e", status: "cancelled" }))).toBe(true);
  });

  it("refuses to plan a move when any family row is not settled", async () => {
    const source = tmp();
    const target = tmp();
    const rows = [row({ id: "sa-1" }), row({ id: "sa-2", status: "running" })];
    await expect(planTransferRegistry({ operationId: "op-1", sourceWorkspace: source, targetWorkspace: target, rows }))
      .rejects.toBeInstanceOf(TransferRegistryConflictError);
  });

  it("refuses conflicting target records without overwriting either side", async () => {
    const source = tmp();
    const target = tmp();
    seed(target, [row({ id: "sa-1", task: "someone else", output: "their result" })]);
    const rows = [row({ id: "sa-1", task: "mine" })];
    await expect(planTransferRegistry({ operationId: "op-1", sourceWorkspace: source, targetWorkspace: target, rows }))
      .rejects.toBeInstanceOf(TransferRegistryConflictError);
    const after = await readTransferRegistryRows(target);
    expect(after).toHaveLength(1);
    expect(after[0]!.task).toBe("someone else");
  });
});

describe("apply / rollback", () => {
  async function prepared() {
    const source = tmp("transfer-src-");
    const target = tmp("transfer-dst-");
    seed(source, [
      row({ id: "sa-1", parentId: "root", sessionPath: join(source, "a.jsonl") }),
      row({ id: "sa-2", parentId: "sa-1", sessionPath: join(source, "b.jsonl") }),
    ]);
    // 目标项目里另一会话的记录：迁移不能碰它。
    seed(target, [row({ id: "sa-other", task: "keep me" })]);
    // 指纹以库里真实行为准（seed 会写入自己的时间戳），避免夹具与 DB 漂移。
    const snapshot = await snapshotTransferRegistryFamily(source, "root");
    const plan = await planTransferRegistry({
      operationId: "op-1", sourceWorkspace: source, targetWorkspace: target, rows: snapshot.rows,
    });
    return { source, target, rows: snapshot.rows, diff: plan.diff };
  }

  it("moves records with CAS, keeps ids/paths, and leaves other sessions alone", async () => {
    const { source, target, rows, diff } = await prepared();
    expect(diff.create.map((item) => item.id)).toEqual(rows.map((item) => item.id).sort());

    await expect(applyTransferRegistryDiff(diff)).resolves.toEqual({ applied: true });
    expect(await readTransferRegistryRows(source)).toEqual([]);
    const moved = await readTransferRegistryRows(target);
    expect(moved.map((item) => item.id).sort()).toEqual(["sa-1", "sa-2", "sa-other"]);
    expect(moved.find((item) => item.id === "sa-1")).toMatchObject({
      sessionPath: rows.find((item) => item.id === "sa-1")!.sessionPath,
      // parentId 保持原值（顶层子代理挂在主会话 id 下），迁移不重写父子关系。
      parentId: "root",
    });
    expect(moved.find((item) => item.id === "sa-2")!.parentId).toBe("sa-1");

    // 幂等：journal 重复提交不多写。
    await expect(applyTransferRegistryDiff(diff)).resolves.toEqual({ applied: false });
  });

  it("rejects when the source rows changed after prepare", async () => {
    const { source, target, diff } = await prepared();
    const registry = new SubAgentRegistry(join(source, ".pi", "subagents", "registry.db"));
    registry.load();
    registry.finish("sa-1", { status: "done", output: "changed after preview" });
    registry.close();

    await expect(applyTransferRegistryDiff(diff)).rejects.toBeInstanceOf(TransferRegistryConflictError);
    expect((await readTransferRegistryRows(target)).map((item) => item.id)).toEqual(["sa-other"]);
  });

  it("rolls back only rows this operation inserted and restores the source", async () => {
    const { source, target, rows, diff } = await prepared();
    await applyTransferRegistryDiff(diff);
    await expect(rollbackTransferRegistryDiff(diff)).resolves.toEqual({ applied: true });

    expect(await readTransferRegistryRows(target)).toHaveLength(1);
    expect((await readTransferRegistryRows(target))[0]!.id).toBe("sa-other");
    const restored = await readTransferRegistryRows(source);
    expect(restored.map((item) => item.id).sort()).toEqual(rows.map((item) => item.id).sort());
    expect(restored.every((item) => transferRegistryRowEquals(item, rows.find((entry) => entry.id === item.id)!))).toBe(true);

    // 再回滚一次是 no-op，不重复补行。
    await expect(rollbackTransferRegistryDiff(diff)).resolves.toEqual({ applied: false });
  });

  it("does not delete a target row that existed before the move when rolling back", async () => {
    const source = tmp("transfer-src-");
    const target = tmp("transfer-dst-");
    seed(source, [row({ id: "sa-1", parentId: "root", task: "same on both sides" })]);
    // 目标里已有与源逐字段相同的记录（幂等往返 / 早已登记）。
    const [shared] = await readTransferRegistryRows(source);
    seedExact(target, [shared!]);
    const plan = await planTransferRegistry({
      operationId: "op-same", sourceWorkspace: source, targetWorkspace: target, rows: [shared!],
    });
    await applyTransferRegistryDiff(plan.diff);
    // 目标本来就有相同行：apply 不插入、不记标记；rollback 只补源，不删目标原有行。
    await rollbackTransferRegistryDiff(plan.diff);
    expect((await readTransferRegistryRows(target)).map((item) => item.id)).toEqual(["sa-1"]);
    expect((await readTransferRegistryRows(source)).map((item) => item.id)).toEqual(["sa-1"]);
  });

  it("keeps the insert marker for a row an external writer changed, so a later rollback still cleans it up", async () => {
    const source = tmp("transfer-src-");
    const target = tmp("transfer-dst-");
    seed(source, [row({ id: "sa-1", parentId: "root", task: "mine" })]);
    seed(target, [row({ id: "sa-other", task: "keep me" })]);
    const [family] = await snapshotTransferRegistryFamily(source, "root").then((snap) => [snap.rows]);
    const plan = await planTransferRegistry({
      operationId: "op-markers", sourceWorkspace: source, targetWorkspace: target, rows: family!,
    });
    const moved = plan.diff.create.find((item) => item.id === "sa-1")!;

    // 模拟 apply 在目标写入后失败：目标有本操作插入的行与标记，源侧还没删。
    const writeTarget = (item: TransferRegistryRow) => {
      const db = readDb(target);
      try {
        db.exec(`CREATE TABLE IF NOT EXISTS session_transfer_registry_inserts (
          operationId TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (operationId, id))`);
        db.prepare('DELETE FROM subagents WHERE id=?').run(item.id);
        db.prepare(
          'INSERT INTO subagents(id, task, profile, model, thinkingLevel, status, output, error, exitCode, transcript, sessionPath, parentId, depth, jobId, bashState, createdAt, updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          item.id, item.task, item.profile, item.model, item.thinkingLevel, item.status, item.output,
          item.error, item.exitCode, item.transcript, item.sessionPath, item.parentId, item.depth,
          item.jobId, item.bashState, item.createdAt, item.updatedAt,
        );
        db.prepare('INSERT OR IGNORE INTO session_transfer_registry_inserts(operationId, id) VALUES(?, ?)')
          .run("op-markers", item.id);
      } finally {
        db.close();
      }
    };
    writeTarget(moved);

    // 外部 writer 改了同一行：rollback 拒绝，但**不能**因此清掉本操作的插入标记。
    writeTarget({ ...moved, output: "their edit", updatedAt: moved.updatedAt + 5 });
    await expect(rollbackTransferRegistryDiff(plan.diff)).rejects.toBeInstanceOf(TransferRegistryConflictError);
    const markerDb = readDb(target);
    try {
      expect(markerDb.prepare('SELECT id FROM session_transfer_registry_inserts WHERE operationId=? AND id=?')
        .get("op-markers", "sa-1")).toMatchObject({ id: "sa-1" });
    } finally {
      markerDb.close();
    }

    // 内容恢复成我们的 create 后，标记仍在 → rollback 能找到并删掉它，源目标不会各留一份。
    writeTarget(moved);
    await expect(rollbackTransferRegistryDiff(plan.diff)).resolves.toEqual({ applied: true });
    expect((await readTransferRegistryRows(target)).map((item) => item.id)).toEqual(["sa-other"]);
    expect((await readTransferRegistryRows(source)).map((item) => item.id)).toEqual(["sa-1"]);
  });

  it("honours expectedTargetHash supplied by the journal", async () => {
    const { target, diff, rows } = await prepared();
    const targetRows = await readTransferRegistryRows(target);
    const familyTargetRows = targetRows.filter((item) => rows.some((moved) => moved.id === item.id));
    expect(familyTargetRows).toEqual([]);
    const mismatched: TransferRegistryDiff = {
      ...diff,
      expectedTargetHash: transferRegistryRowsHashInReadOrder([row({ id: "sa-stale" })]),
    };
    await expect(applyTransferRegistryDiff(mismatched)).rejects.toBeInstanceOf(TransferRegistryConflictError);
    const correct: TransferRegistryDiff = { ...diff, expectedTargetHash: transferRegistryRowsHashInReadOrder(familyTargetRows) };
    await expect(applyTransferRegistryDiff(correct)).resolves.toEqual({ applied: true });
  });

  it("never moves an unsettled row even if the diff asks for it", async () => {
    const source = tmp("transfer-src-");
    const target = tmp("transfer-dst-");
    const rows = [row({ id: "sa-live", status: "running" })];
    const diff: TransferRegistryDiff = {
      operationId: "op-live", sourceWorkspace: source, targetWorkspace: target,
      remove: rows, create: rows, expectedSourceHash: transferRegistryRowsHash(rows),
    };
    await expect(applyTransferRegistryDiff(diff)).rejects.toBeInstanceOf(TransferRegistryConflictError);
  });
});

describe("core port adapters", () => {
  it("exposes read/apply/rollback in the shape the host owner expects", async () => {
    const source = tmp("transfer-src-");
    const target = tmp("transfer-dst-");
    seed(source, [row({ id: "sa-1", parentId: "root", sessionPath: join(source, "a.jsonl") })]);
    const [family] = await snapshotTransferRegistryFamily(source, "root").then((snap) => [snap.rows]);
    expect(await transferRegistryPort.read(source)).toHaveLength(1);
    const plan = await planTransferRegistry({
      operationId: "op-port", sourceWorkspace: source, targetWorkspace: target, rows: family!,
    });
    await transferRegistryPort.apply(plan.diff);
    expect((await transferRegistryPort.read(target)).map((item) => item.id)).toEqual(["sa-1"]);
    await transferRegistryPort.rollback(plan.diff);
    expect(await transferRegistryPort.read(target)).toEqual([]);
  });

  it("maps an owner family to busy/drain inputs and reports unsettled children", () => {
    const workspace = tmp();
    seed(workspace, [row({ id: "sa-live", status: "running", sessionPath: "/ws/live.jsonl" })]);
    const family = { members: [{ sessionPath: "/ws/live.jsonl", sessionId: "sa-live", agentId: "sa-live" }] };
    expect(transferActivityBusy({ sourceWorkspace: workspace, family }))
      .toMatchObject({ busyReason: "subagent-unsettled" });
    expect(transferFamilyRefs({ sourceWorkspace: workspace, family })).toEqual([
      { sessionPath: "/ws/live.jsonl", sessionId: "sa-live", agentId: "sa-live", workspace },
    ]);

    seed(workspace, [row({ id: "sa-idle", sessionPath: "/ws/idle.jsonl" })]);
    expect(transferActivityBusy({
      sourceWorkspace: workspace,
      family: { members: [{ sessionPath: "/ws/idle.jsonl", sessionId: "sa-idle", agentId: "sa-idle" }] },
    })).toBeUndefined();
  });
});

describe("activity and drain", () => {
  it("reports a settled family as idle and a running registry row as busy", async () => {
    const workspace = tmp();
    seed(workspace, [row({ id: "sa-1", sessionPath: "/ws/child.jsonl" })]);
    expect(checkTransferFamilyActivity([
      { sessionPath: "/ws/parent.jsonl", sessionId: "p1" },
      { sessionPath: "/ws/child.jsonl", sessionId: "sa-1", agentId: "sa-1", workspace },
    ])).toBeUndefined();

    seed(workspace, [row({ id: "sa-2", status: "running", sessionPath: "/ws/live.jsonl" })]);
    expect(checkTransferFamilyActivity([
      { sessionPath: "/ws/live.jsonl", sessionId: "sa-2", agentId: "sa-2", workspace },
    ])).toContain("子代理");
  });

  it("rejects an empty / unidentifiable family instead of guessing", () => {
    expect(checkTransferFamilyActivity([])).toBeTruthy();
    expect(checkTransferFamilyActivity([{ sessionPath: "  " }])).toBeTruthy();
  });

  it("awaits each resident's confirmed dispose before reporting it drained", async () => {
    const workspace = tmp();
    seed(workspace, [row({ id: "sa-1", sessionPath: "/ws/child.jsonl" })]);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const drain = drainTransferFamily(
      [
        { sessionPath: "/ws/child.jsonl", sessionId: "sa-1", agentId: "sa-1", workspace },
        { sessionPath: "/ws/other.jsonl", sessionId: "other", agentId: "other", workspace },
      ],
      {
        deps: {
          residentChildIds: () => ["sa-1", "other", "sa-unregistered"],
          residentIsIdle: () => true,
          disposeResidentForTransfer: async (id) => {
            order.push(`start:${id}`);
            // 模拟 worker 代理：dispose 立即返回不够，必须等回执。
            if (id === "sa-1") await gate;
            order.push(`done:${id}`);
            return { confirmed: true };
          },
        },
      },
    );
    // 迁移（journal 写前）必须看到 drain 未完成：这里模拟调用方在 await 之前不能往下走。
    await Promise.resolve();
    expect(order).toEqual(["start:sa-1"]);
    let settled = false;
    void drain.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(drain).resolves.toEqual({
      drained: ["sa-1", "other"],
      busy: [],
      diagnostics: [],
    });
    expect(order).toEqual(["start:sa-1", "done:sa-1", "start:other", "done:other"]);
  });

  it("keeps the registry/journal write behind the awaited drain (the old worker cannot append after CAS)", async () => {
    const source = tmp("transfer-src-");
    const target = tmp("transfer-dst-");
    seed(source, [row({ id: "sa-1", parentId: "root", sessionPath: join(source, "a.jsonl") })]);
    const [family] = await snapshotTransferRegistryFamily(source, "root").then((snap) => [snap.rows]);
    const plan = await planTransferRegistry({
      operationId: "op-order", sourceWorkspace: source, targetWorkspace: target, rows: family!,
    });

    const events: string[] = [];
    let ackWorker!: () => void;
    const workerStopped = new Promise<void>((resolve) => {
      ackWorker = resolve;
    });
    const drain = drainTransferFamily(
      [{ sessionPath: join(source, "a.jsonl"), sessionId: "sa-1", agentId: "sa-1", workspace: source }],
      {
        deps: {
          residentChildIds: () => ["sa-1"],
          residentIsIdle: () => true,
          disposeResidentForTransfer: async () => {
            events.push("dispose:sent");
            await workerStopped;
            events.push("dispose:confirmed");
            return { confirmed: true };
          },
        },
      },
    );
    // 迁移 owner 的顺序：先 await drain（旧写者收口），之后才 apply registry 差异。
    const migrate = (async () => {
      const result = await drain;
      if (result.busy.length > 0) throw new Error("busy");
      events.push("registry:apply");
      await applyTransferRegistryDiff(plan.diff);
      events.push("registry:applied");
    })();

    await Promise.resolve();
    expect(events).toEqual(["dispose:sent"]);
    expect(await readTransferRegistryRows(source)).toHaveLength(1);
    ackWorker();
    await migrate;
    expect(events).toEqual(["dispose:sent", "dispose:confirmed", "registry:apply", "registry:applied"]);
    expect(await readTransferRegistryRows(source)).toEqual([]);
    expect((await readTransferRegistryRows(target)).map((item) => item.id)).toEqual(["sa-1"]);
  });

  it("keeps refusing after a first timeout until the disposition is proven (no 'not in pool = idle')", async () => {
    const workspace = tmp();
    seed(workspace, [row({ id: "sa-slow", sessionPath: "/ws/slow.jsonl" })]);
    let confirmed = false;
    let residentPooled = true;
    const deps = {
      residentChildIds: () => (residentPooled ? ["sa-slow"] : []),
      // 超时后不在驻留池，但仍在迁移隔离区：drain 必须继续看见它。
      unsettledRetiringWriterIds: () => (confirmed ? [] : ["sa-slow"]),
      residentIsIdle: () => !confirmed,
      disposeResidentForTransfer: async () => {
        residentPooled = false;
        return confirmed ? { confirmed: true } : { confirmed: false, diagnostic: "timeout" };
      },
    };
    const members = [{ sessionPath: "/ws/slow.jsonl", sessionId: "sa-slow", agentId: "sa-slow", workspace }];

    const first = await drainTransferFamily(members, { deps, timeoutMs: 5 });
    expect(first.drained).toEqual([]);
    expect(first.busy).toEqual(["sa-slow"]);

    // 第一次超时后它已不在可复用驻留池：不能因此变成「成功」。
    expect(residentPooled).toBe(false);
    const second = await drainTransferFamily(members, { deps, timeoutMs: 5 });
    expect(second.drained).toEqual([]);
    expect(second.busy).toEqual(["sa-slow"]);

    // 迟到回执 / 进程退出之后隔离区收敛：没有待确认的写者，迁移可以继续。
    confirmed = true;
    const third = await drainTransferFamily(members, { deps, timeoutMs: 5 });
    expect(third.busy).toEqual([]);
    expect(third.diagnostics).toEqual([]);
  });

  it("reports busy with a diagnostic when a worker cannot prove it stopped writing", async () => {
    const workspace = tmp();
    seed(workspace, [row({ id: "sa-slow", sessionPath: "/ws/slow.jsonl" })]);
    const result = await drainTransferFamily(
      [{ sessionPath: "/ws/slow.jsonl", sessionId: "sa-slow", agentId: "sa-slow", workspace }],
      {
        timeoutMs: 5,
        deps: {
          residentChildIds: () => ["sa-slow"],
          residentIsIdle: () => true,
          disposeResidentForTransfer: async () => ({
            confirmed: false,
            diagnostic: "worker did not acknowledge dispose before timeout",
          }),
        },
      },
    );
    expect(result.drained).toEqual([]);
    expect(result.busy).toEqual(["sa-slow"]);
    expect(result.diagnostics[0]).toContain("sa-slow");
  });

  it("does not drain a resident whose registry row says it is running, or that looks busy", async () => {
    const workspace = tmp();
    seed(workspace, [
      row({ id: "sa-live", status: "running", sessionPath: "/ws/live.jsonl" }),
      row({ id: "sa-idle-row", sessionPath: "/ws/idle.jsonl" }),
    ]);
    const disposed: string[] = [];
    const result = await drainTransferFamily(
      [
        { sessionPath: "/ws/live.jsonl", sessionId: "sa-live", agentId: "sa-live", workspace },
        { sessionPath: "/ws/idle.jsonl", sessionId: "sa-idle-row", agentId: "sa-idle-row", workspace },
      ],
      {
        deps: {
          residentChildIds: () => ["sa-live", "sa-idle-row"],
          residentIsIdle: (id) => id !== "sa-idle-row",
          disposeResidentForTransfer: async (id) => {
            disposed.push(id);
            return { confirmed: true };
          },
        },
      },
    );
    expect(disposed).toEqual([]);
    expect(result.drained).toEqual([]);
    expect(result.busy).toEqual(["sa-live", "sa-idle-row"]);
    expect(result.diagnostics).toHaveLength(2);
  });
});
