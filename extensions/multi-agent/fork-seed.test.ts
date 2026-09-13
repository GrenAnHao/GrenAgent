import { describe, expect, it } from "vitest";
import { completedPrefix } from "./fork-seed.js";

const user = (text: string) => ({ role: "user", content: text });
const assistant = (text: string, toolCallId?: string) => ({
  role: "assistant",
  content: toolCallId
    ? [{ type: "toolCall", id: toolCallId, name: "spawn_agent", arguments: {} }, { type: "text", text }]
    : [{ type: "text", text }],
});
const toolResult = (toolCallId: string, text: string) => ({
  role: "toolResult",
  toolCallId,
  content: [{ type: "text", text }],
});

describe("completedPrefix", () => {
  it("drops the in-flight spawn assistant matching toolCallId", () => {
    const prefix = completedPrefix(
      [user("hi"), assistant("thinking", "tc-1")],
      "tc-1",
    );
    expect(prefix).toEqual([user("hi")]);
  });

  it("keeps a sibling spawn toolResult when cutting another toolCallId", () => {
    const other = assistant("other", "tc-a");
    const tr = toolResult("tc-a", "done");
    const mine = assistant("mine", "tc-b");
    const prefix = completedPrefix([user("u"), other, tr, mine], "tc-b");
    expect(prefix).toEqual([user("u"), other, tr]);
  });

  it("drops last assistant when toolCallId not yet persisted", () => {
    const prefix = completedPrefix([user("u"), assistant("half")], "tc-missing");
    expect(prefix).toEqual([user("u")]);
  });

  it("keeps sole user when no assistant", () => {
    expect(completedPrefix([user("only")], "tc")).toEqual([user("only")]);
  });

  it("empty input is empty prefix", () => {
    expect(completedPrefix([], "tc")).toEqual([]);
  });

  it("ignores custom messages even if passed in", () => {
    const prefix = completedPrefix(
      [{ role: "custom", customType: "subagent_catalog", content: "x" }, user("u")],
      "tc",
    );
    expect(prefix).toEqual([user("u")]);
  });
});
