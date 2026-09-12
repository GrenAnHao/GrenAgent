import { describe, expect, it } from "vitest";
import { bwrapArgv } from "./bwrap.js";

const caller = ["bash", "-c", "true"];
const tempDir = "/tmp/pi-sandbox-s1";
const workspaceRoot = "/home/user/project";

function hasSeq(argv: string[], seq: string[]): boolean {
  return argv.some((_, i) => seq.every((token, j) => argv[i + j] === token));
}

describe("bwrapArgv", () => {
  it("read-only binds root ro, dies with parent, unshares pid, and binds tempDir", () => {
    const argv = bwrapArgv({ mode: "read-only", workspaceRoot }, caller, tempDir);
    expect(argv[0]).toBe("bwrap");
    expect(hasSeq(argv, ["--ro-bind", "/", "/"])).toBe(true);
    expect(argv.indexOf("--ro-bind")).toBeLessThan(argv.indexOf("--proc"));
    expect(argv.indexOf("--ro-bind")).toBeLessThan(argv.indexOf("--dev"));
    expect(argv).toContain("--die-with-parent");
    expect(argv).toContain("--unshare-pid");
    expect(hasSeq(argv, ["--bind", tempDir, tempDir])).toBe(true);
    expect(argv).not.toContain("--unshare-net");
    expect(hasSeq(argv, ["--bind", workspaceRoot, workspaceRoot])).toBe(false);
    const sep = argv.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(argv.slice(sep + 1)).toEqual(caller);
  });

  it("workspace-write also binds the workspace and still binds tempDir", () => {
    const argv = bwrapArgv({ mode: "workspace-write", workspaceRoot }, caller, tempDir);
    expect(hasSeq(argv, ["--bind", tempDir, tempDir])).toBe(true);
    expect(hasSeq(argv, ["--bind", workspaceRoot, workspaceRoot])).toBe(true);
    expect(argv).not.toContain("--unshare-net");
    const sep = argv.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(argv.slice(sep + 1)).toEqual(caller);
  });
});
