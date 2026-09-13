import { describe, expect, it, vi } from "vitest";
import { completedPrefix, writeSeed } from "./fork-seed.js";

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

describe("writeSeed", () => {
  it("appends each prefix message without rewriting tool ids", () => {
    const mine = assistant("mine", "tc-1");
    const tr = toolResult("tc-1", "done");
    const appendMessage = vi.fn();
    const n = writeSeed({ appendMessage }, [user("u"), mine, tr]);
    expect(n).toBe(3);
    expect(appendMessage).toHaveBeenCalledTimes(3);
    expect(appendMessage.mock.calls[1][0]).toBe(mine);
    expect(appendMessage.mock.calls[2][0]).toBe(tr);
    expect((appendMessage.mock.calls[1][0] as { content: Array<{ id?: string }> }).content[0].id).toBe("tc-1");
    expect((appendMessage.mock.calls[2][0] as { toolCallId: string }).toolCallId).toBe("tc-1");
    expect(appendMessage.mock.calls.some((c) => c[0] && typeof c[0] === "object" && "parentId" in (c[0] as object))).toBe(false);
  });

  it("empty prefix writes nothing and returns 0", () => {
    const appendMessage = vi.fn();
    expect(writeSeed({ appendMessage }, [])).toBe(0);
    expect(appendMessage).not.toHaveBeenCalled();
  });
});
