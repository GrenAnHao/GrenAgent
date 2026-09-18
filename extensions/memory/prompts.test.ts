import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LOCAL_MEMORY_EXTRACT_SYSTEM } from "./prompts.js";

/** 运行时取值，不含定界反引号；与 electron memoryPrompts.ts UPSTREAM.work 一致。 */
const UPSTREAM_WORK = {
  chars: 5269,
  sha256: "392b45852d0c08cad60d02f59d7660d3c09e1d47db78c3c4baf49bee9a3460c8",
} as const;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("LOCAL_MEMORY_EXTRACT_SYSTEM", () => {
  it("与 electron work 版逐字一致（长度 + sha256）", () => {
    expect(LOCAL_MEMORY_EXTRACT_SYSTEM.length).toBe(UPSTREAM_WORK.chars);
    expect(sha256(LOCAL_MEMORY_EXTRACT_SYSTEM)).toBe(UPSTREAM_WORK.sha256);
  });

  it("mirrors the electron work extraction prompt anchors", () => {
    expect(LOCAL_MEMORY_EXTRACT_SYSTEM).toContain("work_fact");
    expect(LOCAL_MEMORY_EXTRACT_SYSTEM).toContain("不应该提取的内容");
    expect(LOCAL_MEMORY_EXTRACT_SYSTEM).toContain("不提取与工作无关的个人偏好");
  });
});
