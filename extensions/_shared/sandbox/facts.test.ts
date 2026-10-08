import { describe, expect, it } from "vitest";
import {
  ESCALATION_TARGETS,
  escalationHintMarker,
  parseSandboxNote,
  runnerFailedMarker,
  sandboxDenialMarker,
  sandboxNotes,
} from "./facts.js";

describe("sandbox fact markers (DSH escalation.ts verbatim)", () => {
  it("names the denied mode", () => {
    expect(sandboxDenialMarker("read-only")).toBe("[sandbox: file access denied under read-only mode]");
  });

  it("teaches the same-call escalation retry", () => {
    expect(escalationHintMarker()).toBe(
      "[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]",
    );
  });

  it("says the runner failed and the command did not run", () => {
    expect(runnerFailedMarker("workspace-write")).toBe(
      "[sandbox: the sandbox runner failed under workspace-write mode — the command did not run; this is a sandbox problem, not a command failure]",
    );
  });

  it("escalation targets are the closed wider-mode vocabulary", () => {
    expect([...ESCALATION_TARGETS]).toEqual(["workspace-write", "danger-full-access"]);
  });
});

describe("sandboxNotes", () => {
  it("a clean run has no notes", () => {
    expect(sandboxNotes({ mode: "read-only", denied: false }, true)).toEqual([]);
  });

  it("a denial carries the hint only when escalation is on offer", () => {
    expect(sandboxNotes({ mode: "read-only", denied: true }, true)).toEqual([
      sandboxDenialMarker("read-only"),
      escalationHintMarker(),
    ]);
    expect(sandboxNotes({ mode: "read-only", denied: true }, false)).toEqual([sandboxDenialMarker("read-only")]);
  });

  it("a runner failure names the mode and passes the reason through, never a hint", () => {
    expect(
      sandboxNotes({ mode: "read-only", denied: false, runnerFailed: "unavailable", detail: "runner missing" }, true),
    ).toEqual([runnerFailedMarker("read-only"), "runner missing"]);
    expect(sandboxNotes({ mode: "read-only", denied: false, runnerFailed: "runner" }, true)).toEqual([
      runnerFailedMarker("read-only"),
    ]);
  });
});

describe("parseSandboxNote", () => {
  it("reads back what processOutcome writes into a job detail", () => {
    expect(
      parseSandboxNote(`exit code: 1; ${sandboxDenialMarker("workspace-write")} ${escalationHintMarker()}`),
    ).toEqual({ kind: "denied", mode: "workspace-write" });
    expect(parseSandboxNote(`${runnerFailedMarker("read-only")} runner missing`)).toEqual({
      kind: "runner-failed",
      mode: "read-only",
    });
  });

  it("ignores details without a sandbox marker", () => {
    expect(parseSandboxNote(undefined)).toBeUndefined();
    expect(parseSandboxNote("exit code: 1")).toBeUndefined();
    expect(parseSandboxNote("killed before exit; cancelled by the user")).toBeUndefined();
  });
});
