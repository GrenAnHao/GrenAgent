// 扩展侧迁移 guard 的注入点：写锁透传 / 注入、只读闸门、阻塞快照 fail-closed。
// 不涉及宿主 lease 实现；宿主用真实 coordinator 接线（electron/app/sessionOperationLease.ts）。
import { describe, expect, it, afterEach } from "vitest";
import {
  SessionOperationGateUnknownError,
  __resetSessionOperationGuardForTest,
  firstSessionOperationBlocker,
  installSessionOperationBlockedSnapshot,
  installSessionOperationGuard,
  installSessionOperationReadGate,
  isSessionOperationBlocked,
  normalizeSessionOperationPathSync,
  sessionOperationBlockedPaths,
  sessionOperationBlockers,
  withSessionOperationGuard,
} from "./session-operation-guard.js";

afterEach(() => __resetSessionOperationGuardForTest());

describe("write guard", () => {
  it("passes straight through when the host installed nothing (CLI / old host / tests)", async () => {
    const order: string[] = [];
    installSessionOperationBlockedSnapshot(undefined);
    await withSessionOperationGuard([], async () => {
      order.push("ran");
    });
    expect(order).toEqual(["ran"]);
  });

  it("takes the declared paths, deduped, and never drops an error from the operation", async () => {
    const seen: string[][] = [];
    installSessionOperationGuard(async (paths, operation) => {
      seen.push([...paths]);
      return operation();
    });
    await withSessionOperationGuard([" /a.jsonl ", "", "/a.jsonl", "/b.jsonl"], async () => undefined);
    expect(seen).toEqual([["/a.jsonl", "/b.jsonl"]]);
    await expect(
      withSessionOperationGuard(["/a.jsonl"], async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("read gate", () => {
  it("returns no blockers without an installed gate", async () => {
    await expect(sessionOperationBlockers({ paths: ["/a.jsonl"] })).resolves.toEqual([]);
    await expect(firstSessionOperationBlocker({ workspaces: ["/ws"] })).resolves.toBeUndefined();
  });

  it("passes paths and workspaces through and exposes the first reason", async () => {
    const queries: unknown[] = [];
    installSessionOperationReadGate(async (query) => {
      queries.push(query);
      return [{ path: "/a.jsonl", reason: "存在未完成的迁移事务", operationId: "op-1" }];
    });
    await expect(firstSessionOperationBlocker({ paths: ["/a.jsonl"], workspaces: ["/ws"] }))
      .resolves.toMatchObject({ reason: "存在未完成的迁移事务", operationId: "op-1" });
    expect(queries).toEqual([{ paths: ["/a.jsonl"], workspaces: ["/ws"] }]);
  });
});

describe("blocked snapshot", () => {
  it("normalizes path spellings so a differently spelled family still matches", () => {
    installSessionOperationBlockedSnapshot(() => ["C:\\Work\\Sessions\\A.jsonl", "/tmp/b/"] );
    expect(isSessionOperationBlocked("c:/work/sessions/a.jsonl")).toBe(true);
    expect(isSessionOperationBlocked("/tmp/b")).toBe(true);
    expect(isSessionOperationBlocked("/tmp/c")).toBe(false);
    expect(isSessionOperationBlocked(undefined)).toBe(false);
  });

  it("fails closed when the host snapshot is broken instead of reporting 'nothing blocked'", () => {
    installSessionOperationBlockedSnapshot(() => {
      throw new Error("journal unreadable");
    });
    expect(() => sessionOperationBlockedPaths()).toThrow(SessionOperationGateUnknownError);
    installSessionOperationBlockedSnapshot(() => (null as unknown as string[]));
    expect(() => sessionOperationBlockedPaths()).toThrow(SessionOperationGateUnknownError);
  });

  it("normalizes a single path the same way as the set", () => {
    // 本机是 Windows：反斜杠与盘符由 resolve 统一；分隔符、大小写、尾斜杠的归一必须一致。
    expect(normalizeSessionOperationPathSync("C:\\A\\B.jsonl")).toBe("c:/a/b.jsonl");
    expect(normalizeSessionOperationPathSync("C:\\A\\")).toBe("c:/a");
    expect(normalizeSessionOperationPathSync("c:/a/b.jsonl")).toBe("c:/a/b.jsonl");
  });
});
