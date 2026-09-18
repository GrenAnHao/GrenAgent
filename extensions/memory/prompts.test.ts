import { describe, expect, it } from "vitest";
import { LOCAL_MEMORY_EXTRACT_SYSTEM } from "./prompts.js";

describe("LOCAL_MEMORY_EXTRACT_SYSTEM", () => {
  it("mirrors the electron work extraction prompt anchors", () => {
    expect(LOCAL_MEMORY_EXTRACT_SYSTEM).toContain("work_fact");
    expect(LOCAL_MEMORY_EXTRACT_SYSTEM).toContain("不应该提取的内容");
    expect(LOCAL_MEMORY_EXTRACT_SYSTEM).toContain("不提取与工作无关的个人偏好");
  });
});
