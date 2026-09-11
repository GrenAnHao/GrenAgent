import { beforeEach, describe, expect, it } from "vitest";
import { rememberPendingDenial, consumePendingDenial, __resetPendingDenialsForTest } from "./pendingDenial.js";

beforeEach(() => __resetPendingDenialsForTest());

it("consumes once then fails", () => {
  rememberPendingDenial("/w", "rm -rf /", "read-only");
  expect(consumePendingDenial("/w", "rm -rf /")).toEqual({ mode: "read-only" });
  expect(consumePendingDenial("/w", "rm -rf /")).toBeUndefined();
});
it("requires byte-identical command", () => {
  rememberPendingDenial("/w", "echo a", "read-only");
  expect(consumePendingDenial("/w", "echo a ")).toBeUndefined();
  expect(consumePendingDenial("/w", "echo a")).toEqual({ mode: "read-only" });
});
it("remember overwrites same key", () => {
  rememberPendingDenial("/w", "x", "read-only");
  rememberPendingDenial("/w", "x", "workspace-write");
  expect(consumePendingDenial("/w", "x")).toEqual({ mode: "workspace-write" });
});
