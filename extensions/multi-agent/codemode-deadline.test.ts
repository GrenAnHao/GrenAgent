import { describe, expect, it } from "vitest";
import { withoutSubagentDeadline } from "./codemode-deadline.js";

describe("withoutSubagentDeadline", () => {
  it("drops timeout_ms and keeps the other options", () => {
    const src = '// @options: {"max_output_tokens": 5000, "timeout_ms": 900000}\nconst r = await tools.spawn_agent({ task: "x" });';
    expect(withoutSubagentDeadline(src)).toBe('// @options: {"max_output_tokens":5000}\nconst r = await tools.spawn_agent({ task: "x" });');
  });

  it("removes the options line when only timeout_ms was set", () => {
    const src = '// @options: {"timeout_ms": 480000}\r\nawait tools["spawn_agent"]({ tasks: ["a", "b"] });';
    expect(withoutSubagentDeadline(src)).toBe('await tools["spawn_agent"]({ tasks: ["a", "b"] });');
  });

  it("keeps CRLF on a rewritten options line", () => {
    const src = '  // @options: {"timeout_ms": 1, "max_output_tokens": 10}\r\nawait tools.spawn_agent({ task: "x" });';
    expect(withoutSubagentDeadline(src)).toBe('// @options: {"max_output_tokens":10}\r\nawait tools.spawn_agent({ task: "x" });');
  });

  it("leaves scripts alone when they do not spawn sub-agents or have no deadline", () => {
    expect(withoutSubagentDeadline('// @options: {"timeout_ms": 60000}\nawait tools.read({ path: "a" });')).toBeUndefined();
    expect(withoutSubagentDeadline('// @options: {"max_output_tokens": 10}\nawait tools.spawn_agent({ task: "x" });')).toBeUndefined();
    expect(withoutSubagentDeadline('await tools.spawn_agent({ task: "x" });')).toBeUndefined();
  });

  it("leaves malformed options for codemode to report", () => {
    expect(withoutSubagentDeadline('// @options: {timeout_ms: 1}\nawait tools.spawn_agent({ task: "x" });')).toBeUndefined();
    expect(withoutSubagentDeadline('// @options: [1]\nawait tools.spawn_agent({ task: "x" });')).toBeUndefined();
  });
});
