// 迁移会话的冷恢复位置 / 项目根纯函数测试（browser-safe 共享层）。
// 只验证「追加行之后是否已开始新活动」的判定，不启动 SDK、不建 runtime。
import { describe, expect, it } from "vitest";
import {
  SESSION_PROJECT_TRANSFER_ENTRY,
  effectiveProjectRoot,
  effectiveRecordedCwd,
  transferredLeafToRestore,
} from "./session-project-transfer.js";

const transfer = (over: Record<string, unknown> = {}) => ({
  type: "custom",
  id: "transfer-1",
  customType: SESSION_PROJECT_TRANSFER_ENTRY,
  data: {
    version: 1,
    operationId: "op-1",
    fromWorkspace: "/source",
    toWorkspace: "/target",
    previousCwd: "/source",
    leafId: "answer-1",
    boundary: { afterEntryId: "answer-1", entryCount: 2 },
    history: { version: 1, ref: "op-1" },
    createdAt: 10,
    ...over,
  },
});

const custom = (customType: string, id = `${customType}-1`) => ({ type: "custom", id, customType, data: {} });
const message = (role: string, id: string) => ({ type: "message", id, message: { role, content: "x", timestamp: 1 } });

describe("transferredLeafToRestore", () => {
  it("restores the confirmed leaf while only transfer appended entries follow", () => {
    const entries = [message("user", "q1"), message("assistant", "answer-1"), transfer(), custom("working_directory"), custom("subagent_meta")];
    expect(transferredLeafToRestore(entries)).toEqual({ leafId: "answer-1", restore: true });
  });

  it("keeps a null root as the confirmed position", () => {
    const entries = [transfer({ leafId: null }), custom("working_directory")];
    expect(transferredLeafToRestore(entries)).toEqual({ leafId: null, restore: true });
  });

  it("does not rewind once a new activity follows the transfer marker", () => {
    const cases = [
      [...[transfer()], message("user", "after-1")],
      [...[transfer()], { type: "usage", id: "u1" }],
      [...[transfer()], { type: "label", id: "l1" }],
      [...[transfer()], { type: "branch_summary", id: "b1" }],
    ];
    for (const entries of cases) {
      expect(transferredLeafToRestore(entries)).toEqual({ leafId: "answer-1", restore: false });
    }
  });

  it("uses the last transfer and ignores unknown metadata versions", () => {
    const older = transfer({ operationId: "op-0", leafId: "old-leaf", createdAt: 1 });
    const newer = transfer({ operationId: "op-2", leafId: "answer-2", createdAt: 2 });
    expect(transferredLeafToRestore([message("assistant", "old-leaf"), older, message("assistant", "answer-2"), newer]))
      .toEqual({ leafId: "answer-2", restore: true });
    const unknown = transfer({ version: 2, leafId: "x" });
    expect(transferredLeafToRestore([message("user", "q"), unknown])).toBeUndefined();
  });

  it("returns undefined for an ordinary session", () => {
    expect(transferredLeafToRestore([message("user", "q1"), message("assistant", "a1")])).toBeUndefined();
  });
});

describe("project root after transfer", () => {
  it("takes the target as the effective project root and ignores source-side working_directory", () => {
    const entries = [
      custom("working_directory", "wd-old"),
      transfer(),
      custom("working_directory", "wd-new"),
    ];
    expect(effectiveProjectRoot(entries, "/source")).toBe("/target");
    expect(effectiveRecordedCwd(entries, "/source")).toBe("/target");
  });

  it("keeps the header cwd when no transfer happened", () => {
    const entries = [custom("working_directory", "wd-old")];
    expect(effectiveProjectRoot(entries, "/source")).toBe("/source");
  });
});
