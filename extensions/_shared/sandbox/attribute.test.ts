import { describe, expect, it } from "vitest";
import { attributeRun } from "./attribute.js";

const confined = {
  argv: ["bwrap", "--", "bash", "-c", "x"],
  enforcement: "full" as const,
  denialExitCodes: [162],
  denialSignatures: ["erofs", "read-only file system"],
  runnerFailureRules: [{
    kind: "runner-launch-failed" as const,
    exitCodes: [127],
    signatures: ["bwrap: executable not found"],
  }],
};

describe("attributeRun", () => {
  it("classifies spawnError ENOENT as runner-failure", () => {
    const spawnError = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    expect(attributeRun({ exitCode: null, spawnError }, confined).kind).toBe("runner-failure");
  });
  it("classifies runner failure before denial", () => {
    expect(attributeRun({ exitCode: 127, stderr: "bwrap: executable not found\n" }, confined).kind)
      .toBe("runner-failure");
  });
  it("classifies structured denial exit", () => {
    expect(attributeRun({ exitCode: 162, stderr: "" }, confined).kind).toBe("denial");
  });
  it("does not treat echoed denial text plus ordinary exit as denial", () => {
    expect(attributeRun({ exitCode: 1, stdout: "erofs is a string in my file\n", stderr: "" }, confined).kind)
      .toBe("command");
  });
  it("allows signature fallback only when exit is nonzero and not a runner failure", () => {
    expect(attributeRun({ exitCode: 1, stderr: "Read-only file system\n" }, confined).kind).toBe("denial");
  });
  it("does not treat null exit without spawnError as denial", () => {
    expect(attributeRun({ exitCode: null, stderr: "Read-only file system\n" }, confined).kind)
      .toBe("command");
  });
});
