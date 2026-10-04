import { describe, expect, it } from "vitest";
import { type AskFn } from "./llm.js";
import { buildCompactionPrompt, extractCompactionState, extractState } from "./writer.js";

describe("extractState", () => {
  it("returns extracted markdown on success", async () => {
    const ask: AskFn = async () => "## Intent\n- build X";
    expect(await extractState(ask, "convo")).toBe("## Intent\n- build X");
  });
  it("keeps prev on empty output", async () => {
    const ask: AskFn = async () => "   ";
    expect(await extractState(ask, "convo", "## Intent\n- old")).toBe("## Intent\n- old");
  });
  it("keeps prev on throw", async () => {
    const ask: AskFn = async () => {
      throw new Error("no model");
    };
    expect(await extractState(ask, "convo", "## Intent\n- old")).toBe("## Intent\n- old");
  });
});

describe("buildCompactionPrompt", () => {
  it("按顺序放上一份状态、上一份摘要、待丢弃对话和切轮前缀", () => {
    const prompt = buildCompactionPrompt({
      prevState: "## Intent\n- prev",
      previousSummary: "old summary",
      conversation: "[User]: hi",
      turnPrefix: "[User]: current turn",
    });
    const order = ["<previous-state>", "<previous-summary>", "<conversation>", "<current-turn-prefix>"].map((t) =>
      prompt.indexOf(t),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(prompt).toContain("<previous-state>\n## Intent\n- prev\n</previous-state>");
    expect(prompt).toContain("middle of the following turn");
  });

  it("缺的段省略", () => {
    const prompt = buildCompactionPrompt({ conversation: "[User]: hi" });
    expect(prompt).toBe("<conversation>\n[User]: hi\n</conversation>");
  });
});

describe("extractCompactionState", () => {
  it("成功时返回去掉首尾空白的输出，系统提示说明输出会替换历史", async () => {
    let system = "";
    const ask: AskFn = async (s) => {
      system = s;
      return "  ## Intent\n- x  ";
    };
    expect(await extractCompactionState(ask, { conversation: "c" })).toBe("## Intent\n- x");
    expect(system).toContain("your output replaces it");
    expect(system).toContain("## Key decisions");
  });

  it("空输出或抛错时返回 undefined，不回退到旧状态", async () => {
    expect(await extractCompactionState(async () => "  ", { conversation: "c", prevState: "old" })).toBeUndefined();
    const failing: AskFn = async () => {
      throw new Error("overflow");
    };
    expect(await extractCompactionState(failing, { conversation: "c", prevState: "old" })).toBeUndefined();
  });
});
