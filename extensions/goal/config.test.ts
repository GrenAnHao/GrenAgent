import { afterEach, describe, expect, it } from "vitest";
import { __resetForTest } from "../_shared/runtime-config.js";
import { readAutoContinueOnOpen } from "./config.js";

afterEach(() => {
  __resetForTest();
  delete process.env["goal.autoContinueOnOpen"];
});

describe("readAutoContinueOnOpen", () => {
  it("is true only for the exact string true", () => {
    process.env["goal.autoContinueOnOpen"] = "true";
    expect(readAutoContinueOnOpen()).toBe(true);
    process.env["goal.autoContinueOnOpen"] = "TRUE";
    expect(readAutoContinueOnOpen()).toBe(false);
    process.env["goal.autoContinueOnOpen"] = "1";
    expect(readAutoContinueOnOpen()).toBe(false);
    process.env["goal.autoContinueOnOpen"] = "false";
    expect(readAutoContinueOnOpen()).toBe(false);
    delete process.env["goal.autoContinueOnOpen"];
    expect(readAutoContinueOnOpen()).toBe(false);
  });
});
