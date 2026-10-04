import { describe, expect, it } from "vitest";
import {
  applyPrunePlan,
  planPressurePrune,
  prunePlaceholder,
  RECENT_KEEP_CHARS,
  softTrimText,
} from "./pressure-prune.js";

type Msg = { role: string; content: unknown; toolCallId?: string; toolName?: string; timestamp?: number };

const user = (t: string): Msg => ({ role: "user", content: t });
const asst = (calls: Array<{ id: string; name?: string; path?: string }> = [], timestamp?: number): Msg => ({
  role: "assistant",
  timestamp,
  content: calls.map((c) => ({
    type: "toolCall",
    id: c.id,
    name: c.name ?? "bash",
    arguments: c.path ? { path: c.path } : {},
  })),
});
const tr = (id: string, text: string, toolName = "bash", extra: unknown[] = []): Msg => ({
  role: "toolResult",
  toolCallId: id,
  toolName,
  content: [{ type: "text", text }, ...extra],
});
const textOf = (m: Msg) => (m.content as Array<{ text?: string }>)[0].text;
const image = { type: "image", data: "AAAA", mimeType: "image/png" };

// 保护范围从 u1 开始（keepRecentTurns = 1）。near 刚好用满 160000，old 及更早进入候选。
const scenario = (): Msg[] => [
  user("u0"),
  asst([{ id: "tiny" }, { id: "old" }, { id: "near" }], 1_000),
  tr("tiny", "t".repeat(100)),
  tr("old", "o".repeat(5000)),
  tr("near", "n".repeat(RECENT_KEEP_CHARS)),
  user("u1"),
  asst([{ id: "fresh" }], 2_000),
  tr("fresh", "f".repeat(50_000)),
];

describe("softTrimText", () => {
  it("留头尾各 1536，中间写去掉的字符数", () => {
    const out = softTrimText("x".repeat(5000));
    expect(out).toBe(`${"x".repeat(1536)}\n[... trimmed, removed 1928 chars ...]\n${"x".repeat(1536)}`);
  });

  it("不切开代理对", () => {
    const text = `${"a".repeat(1535)}😀${"b".repeat(3000)}😀${"c".repeat(1535)}`;
    expect(softTrimText(text)).toBe(`${"a".repeat(1535)}\n[... trimmed, removed 3004 chars ...]\n${"c".repeat(1535)}`);
  });
});

describe("planPressurePrune", () => {
  const opts = { keepRecentTurns: 1, minBodyChars: 1000 };

  it("等级 0 不裁", () => {
    expect(planPressurePrune(scenario(), { ...opts, level: 0 }).size).toBe(0);
  });

  it("用户消息不超过保留轮数时不裁", () => {
    expect(planPressurePrune(scenario(), { ...opts, keepRecentTurns: 2, level: 3 }).size).toBe(0);
  });

  it("等级 1：最近 160000 字符和保护范围内不动，跨界那条起超过 4096 的标 soft", () => {
    const plan = planPressurePrune(scenario(), { ...opts, level: 1 });
    expect([...plan]).toEqual([["old", "soft"]]);
  });

  it("读 SKILL.md 的结果不计入 160000，也不进入候选", () => {
    const msgs: Msg[] = [
      user("u0"),
      asst([{ id: "old" }, { id: "near" }, { id: "sk", name: "read", path: "C:\\skills\\demo\\SKILL.md" }], 1_000),
      tr("old", "o".repeat(5000)),
      tr("near", "n".repeat(RECENT_KEEP_CHARS)),
      tr("sk", "s".repeat(200_000), "read"),
      user("u1"),
    ];
    const plan = planPressurePrune(msgs, { ...opts, level: 1 });
    expect([...plan]).toEqual([["old", "soft"]]);
  });

  it("等级 2：整段替换省下达到 80000 时标 replace，短于 MIN_BODY 的不动", () => {
    const msgs: Msg[] = [
      user("u0"),
      asst([], 1_000),
      tr("small", "s".repeat(500)),
      tr("big1", "a".repeat(50_000)),
      tr("big2", "b".repeat(50_000)),
      tr("near", "n".repeat(RECENT_KEEP_CHARS)),
      user("u1"),
    ];
    const plan = planPressurePrune(msgs, { ...opts, level: 2 });
    expect(Object.fromEntries(plan)).toEqual({ big1: "replace", big2: "replace" });
  });

  it("等级 3：省下不足 80000 时退回软裁", () => {
    const plan = planPressurePrune(scenario(), { ...opts, level: 3 });
    expect([...plan]).toEqual([["old", "soft"]]);
  });
});

describe("applyPrunePlan", () => {
  it("soft：文本块用换行接成一块放最前，非文本块跟在后面，不改输入", () => {
    const msg: Msg = {
      role: "toolResult",
      toolCallId: "x",
      toolName: "read",
      content: [{ type: "text", text: "p".repeat(3000) }, image, { type: "text", text: "q".repeat(3000) }],
    };
    const before = structuredClone(msg);
    const res = applyPrunePlan([msg], new Map([["x", "soft"]]));
    expect(res.applied).toBe(1);
    expect(res.messages[0].content).toEqual([
      { type: "text", text: `${"p".repeat(1536)}\n[... trimmed, removed 2929 chars ...]\n${"q".repeat(1536)}` },
      image,
    ]);
    expect(res.savedChars).toBe(6001 - textOf(res.messages[0])!.length);
    expect(msg).toEqual(before);
  });

  it("replace：整段换成占位，去掉非文本块", () => {
    const msg = tr("x", "z".repeat(2000), "", [image]);
    const res = applyPrunePlan([msg], new Map([["x", "replace"]]));
    expect(res.messages[0].content).toEqual([{ type: "text", text: prunePlaceholder(undefined, 2000) }]);
    expect(textOf(res.messages[0])).toBe("[pruned tool output: tool, 2000 chars]");
  });

  it("空计划或没命中时返回原数组", () => {
    const msgs = scenario();
    expect(applyPrunePlan(msgs, new Map()).messages).toBe(msgs);
    expect(applyPrunePlan(msgs, new Map([["missing", "soft"]])).messages).toBe(msgs);
  });

  it("soft 遇到不超过 4096 的正文保持原文", () => {
    const msgs = [tr("x", "short")];
    expect(applyPrunePlan(msgs, new Map([["x", "soft"]])).messages).toBe(msgs);
  });
});
