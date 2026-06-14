import { afterEach, describe, expect, it } from "vitest";
import { extractFinalText, resolvePiCommand, resolveSubagentModel } from "./runner.js";

const origPiBin = process.env.PI_BIN;
const origSubagentModel = process.env.SUBAGENT_MODEL;
afterEach(() => {
  if (origPiBin === undefined) delete process.env.PI_BIN;
  else process.env.PI_BIN = origPiBin;
  if (origSubagentModel === undefined) delete process.env.SUBAGENT_MODEL;
  else process.env.SUBAGENT_MODEL = origSubagentModel;
});

describe("resolvePiCommand", () => {
  it("prefers PI_BIN when set", () => {
    process.env.PI_BIN = "/custom/pi";
    expect(resolvePiCommand().cmd).toBe("/custom/pi");
  });
  it("falls back to the current executable (sidecar self), not bare 'pi'", () => {
    delete process.env.PI_BIN;
    expect(resolvePiCommand().cmd).toBe(process.execPath);
  });
});

describe("resolveSubagentModel", () => {
  it("returns trimmed SUBAGENT_MODEL when set", () => {
    process.env.SUBAGENT_MODEL = "  deepseek/deepseek-chat  ";
    expect(resolveSubagentModel()).toBe("deepseek/deepseek-chat");
  });
  it("returns undefined when unset or blank", () => {
    delete process.env.SUBAGENT_MODEL;
    expect(resolveSubagentModel()).toBeUndefined();
    process.env.SUBAGENT_MODEL = "   ";
    expect(resolveSubagentModel()).toBeUndefined();
  });
});

describe("extractFinalText", () => {
  it("returns the last assistant text from JSONL", () => {
    const jsonl = [
      JSON.stringify({ role: "assistant", content: "first" }),
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } }),
    ].join("\n");
    expect(extractFinalText(jsonl)).toBe("final answer");
  });
  it("falls back to a tail slice when no assistant message is present", () => {
    expect(extractFinalText("not json at all")).toBe("not json at all");
  });
});
