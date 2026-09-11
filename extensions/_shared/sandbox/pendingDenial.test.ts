import { beforeEach, describe, expect, it } from "vitest";
import {
  rememberPendingDenial,
  consumePendingDenial,
  clearPendingDenials,
  __resetPendingDenialsForTest,
} from "./pendingDenial.js";

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
it("consumes across slash and trailing-separator workspace forms", () => {
  rememberPendingDenial("D:\\repo", "echo a", "read-only");
  expect(consumePendingDenial("D:/repo/", "echo a")).toEqual({ mode: "read-only" });
});
it("isolates the same workspace and command by sessionId", () => {
  rememberPendingDenial("/w", "x", "read-only", "s1");
  rememberPendingDenial("/w", "x", "workspace-write", "s2");
  expect(consumePendingDenial("/w", "x", "s1")).toEqual({ mode: "read-only" });
  expect(consumePendingDenial("/w", "x", "s2")).toEqual({ mode: "workspace-write" });
});
it("clearPendingDenials drops every record for that sessionId", () => {
  rememberPendingDenial("/w", "a", "read-only", "s1");
  rememberPendingDenial("/w", "b", "workspace-write", "s1");
  rememberPendingDenial("/w", "c", "read-only", "s2");
  rememberPendingDenial("/w", "d", "read-only");
  clearPendingDenials("s1");
  expect(consumePendingDenial("/w", "a", "s1")).toBeUndefined();
  expect(consumePendingDenial("/w", "b", "s1")).toBeUndefined();
  expect(consumePendingDenial("/w", "c", "s2")).toEqual({ mode: "read-only" });
  expect(consumePendingDenial("/w", "d")).toEqual({ mode: "read-only" });
});
