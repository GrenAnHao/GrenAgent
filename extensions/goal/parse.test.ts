import { describe, expect, it } from "vitest";
import { parseGoalArgs } from "./parse.js";

describe("parseGoalArgs", () => {
  it("parses the command table", () => {
    expect(parseGoalArgs("")).toEqual({ type: "query" });
    expect(parseGoalArgs("   ")).toEqual({ type: "query" });
    expect(parseGoalArgs("pause")).toEqual({ type: "pause" });
    expect(parseGoalArgs("PAUSE")).toEqual({ type: "pause" });
    expect(parseGoalArgs("resume")).toEqual({ type: "resume" });
    expect(parseGoalArgs("clear")).toEqual({ type: "clear" });
    expect(parseGoalArgs("reset")).toEqual({ type: "clear" });
    expect(parseGoalArgs("edit")).toEqual({ type: "error", code: "MISSING_CONDITION" });
    expect(parseGoalArgs("edit   ")).toEqual({ type: "error", code: "MISSING_CONDITION" });
    expect(parseGoalArgs("edit 写完")).toEqual({ type: "edit", condition: "写完" });
    expect(parseGoalArgs("EDIT 写完")).toEqual({ type: "edit", condition: "写完" });
    expect(parseGoalArgs("pause after verify")).toEqual({ type: "create", condition: "pause after verify" });
    expect(parseGoalArgs("写完并通过测试")).toEqual({ type: "create", condition: "写完并通过测试" });
  });

  it("rejects empty or overlong conditions after trim", () => {
    expect(parseGoalArgs("a".repeat(4001))).toEqual({ type: "error", code: "INVALID_PARAMS" });
    expect(parseGoalArgs(`edit ${"a".repeat(4001)}`)).toEqual({ type: "error", code: "INVALID_PARAMS" });
  });
});
