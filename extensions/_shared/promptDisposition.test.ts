import { describe, expect, it } from "vitest";
import { promptWasAccepted } from "./promptDisposition.js";

describe("promptWasAccepted", () => {
  it("accepts handled, queued, and started", () => {
    expect(promptWasAccepted("handled")).toBe(true);
    expect(promptWasAccepted("queued")).toBe(true);
    expect(promptWasAccepted("started")).toBe(true);
  });
  it("rejects booleans and other strings", () => {
    expect(promptWasAccepted(true)).toBe(false);
    expect(promptWasAccepted(false)).toBe(false);
    expect(promptWasAccepted("nope")).toBe(false);
  });
});
