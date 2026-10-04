import { describe, expect, it } from "vitest";
import { registerToolName, serverNamesConflict } from "./naming.js";

describe("registerToolName", () => {
  it("sanitizes and prefixes", () => {
    expect(registerToolName("my-server", "read-file", new Set()).name).toBe("mcp__my_server__read_file");
  });
  it("appends an 8-hex hash when two tools sanitize to the same name", () => {
    const first = registerToolName("s", "read-file", new Set());
    const second = registerToolName("s", "read_file", new Set([first.name]));
    expect(second.name).not.toBe(first.name);
    expect(second.name.length).toBeLessThanOrEqual(64);
    expect(second.name).toMatch(/_[0-9a-f]{8}$/);
    expect(second.originalToolName).toBe("read_file");
  });
});

describe("serverNamesConflict", () => {
  it("treats dash and underscore as the same server", () => {
    expect(serverNamesConflict("dev-radius", "dev_radius")).toBe(true);
    expect(serverNamesConflict("dev-radius", "other")).toBe(false);
  });
});
