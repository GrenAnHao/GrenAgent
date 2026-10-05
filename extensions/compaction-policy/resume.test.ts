import { describe, expect, it } from "vitest";
import { isCompactionCancelled, shouldResumeAfterAutoCompact, viewAutoCompactTurn } from "./resume.js";

describe("shouldResumeAfterAutoCompact", () => {
  it("工具还没跑完时续跑", () => {
    expect(shouldResumeAfterAutoCompact({ stopReason: "toolUse", toolResultCount: 1, hasPendingMessages: false })).toBe(true);
  });

  it("输出被截断时续跑", () => {
    expect(shouldResumeAfterAutoCompact({ stopReason: "length", toolResultCount: 0, hasPendingMessages: false })).toBe(true);
  });

  it("还有排队消息时续跑", () => {
    expect(shouldResumeAfterAutoCompact({ stopReason: "stop", toolResultCount: 0, hasPendingMessages: true })).toBe(true);
  });

  it("模型正常说完且没有排队消息时不续跑", () => {
    expect(shouldResumeAfterAutoCompact({ stopReason: "stop", toolResultCount: 0, hasPendingMessages: false })).toBe(false);
  });

  it("用户取消时不续跑", () => {
    expect(shouldResumeAfterAutoCompact({ stopReason: "aborted", toolResultCount: 1, hasPendingMessages: true })).toBe(false);
  });
});

describe("viewAutoCompactTurn", () => {
  it("从 turn_end 事件取出停止原因和工具结果数", () => {
    expect(viewAutoCompactTurn({
      message: { stopReason: "toolUse" },
      toolResults: [{}, {}],
    }, false)).toEqual({
      stopReason: "toolUse",
      toolResultCount: 2,
      hasPendingMessages: false,
    });
  });

  it("缺字段时按空回合处理", () => {
    expect(viewAutoCompactTurn(undefined, false)).toEqual({
      stopReason: undefined,
      toolResultCount: 0,
      hasPendingMessages: false,
    });
  });
});

describe("isCompactionCancelled", () => {
  it("识别取消", () => {
    expect(isCompactionCancelled("Compaction cancelled")).toBe(true);
    expect(isCompactionCancelled("Request was aborted")).toBe(true);
  });

  it("摘要失败不算取消", () => {
    expect(isCompactionCancelled("Nothing to compact (session too small)")).toBe(false);
    expect(isCompactionCancelled("Already compacted")).toBe(false);
  });
});
