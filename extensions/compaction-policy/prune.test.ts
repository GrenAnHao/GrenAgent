import { describe, expect, it } from "vitest";
import { fuseOversizeToolResults, textLength } from "./prune.js";

const tr = (toolName: string, text: string) => ({ role: "toolResult", toolName, content: [{ type: "text", text }] });
const user = (t: string) => ({ role: "user", content: t });
const asst = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });


describe("textLength", () => {
  it("只加总文本块", () => {
    expect(textLength([{ type: "text", text: "abc" }, { type: "image" }, { type: "text", text: "de" }])).toBe(5);
    expect(textLength("plain")).toBe(0);
  });
});

describe("fuseOversizeToolResults", () => {
  it("replaces oversized toolResult bodies even inside the recent-turn window", () => {
    const bomb = "x".repeat(100_000);
    const msgs = [user("only-turn"), tr("search", bomb), asst("ok")];
    const res = fuseOversizeToolResults(msgs, 80_000);
    expect(res.fusedCount).toBe(1);
    const text = (res.messages[1] as { content: { text: string }[] }).content[0].text;
    expect(text).toMatch(/truncated tool output: search, 100000 chars/);
    expect(text.length).toBeLessThan(500);
    expect((res.messages[2] as { content: { text: string }[] }).content[0].text).toBe("ok");
  });
  it("leaves small tool results and non-tool messages untouched", () => {
    const msgs = [user("u"), tr("read", "hello"), asst("a")];
    const res = fuseOversizeToolResults(msgs, 80_000);
    expect(res.fusedCount).toBe(0);
    expect(res.messages).toBe(msgs);
  });
  it("is a no-op when maxBodyChars is 0", () => {
    const msgs = [tr("search", "z".repeat(200_000))];
    const res = fuseOversizeToolResults(msgs, 0);
    expect(res.fusedCount).toBe(0);
    expect(res.messages).toBe(msgs);
  });
});
