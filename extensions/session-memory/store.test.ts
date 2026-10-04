import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readState, readStateDoc, stateOnBranch, statePath, writeState, writeStateDoc } from "./store.js";

describe("store", () => {
  it("write then read round-trips; path uses sessionId", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-"));
    const p = statePath(dir, "sess123");
    expect(p.endsWith(join(".pi", "session-state", "sess123.md"))).toBe(true);
    writeState(p, "## Intent\n- x");
    expect(readState(p)).toBe("## Intent\n- x");
  });
  it("read missing → undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "sm-"));
    expect(readState(statePath(dir, "none"))).toBeUndefined();
  });
});

describe("state doc 锚点", () => {
  it("带锚点写入后读回正文和锚点", () => {
    const p = statePath(mkdtempSync(join(tmpdir(), "sm-")), "s");
    writeStateDoc(p, "## Intent\n- x", "e42");
    expect(readState(p)).toBe("<!-- session-state anchor=e42 -->\n## Intent\n- x");
    expect(readStateDoc(p)).toEqual({ body: "## Intent\n- x", anchor: "e42" });
  });

  it("没有锚点的旧文件只读出正文", () => {
    const p = statePath(mkdtempSync(join(tmpdir(), "sm-")), "s");
    writeState(p, "## Intent\n- legacy");
    expect(readStateDoc(p)).toEqual({ body: "## Intent\n- legacy" });
  });

  it("stateOnBranch 只在锚点位于分支且正文非空时返回正文", () => {
    const branch = [{ id: "e1" }, { id: "e2" }];
    expect(stateOnBranch({ body: "## Intent", anchor: "e2" }, branch)).toBe("## Intent");
    expect(stateOnBranch({ body: "## Intent", anchor: "gone" }, branch)).toBeUndefined();
    expect(stateOnBranch({ body: "## Intent" }, branch)).toBeUndefined();
    expect(stateOnBranch({ body: "  \n", anchor: "e1" }, branch)).toBeUndefined();
    expect(stateOnBranch(undefined, branch)).toBeUndefined();
  });
});
