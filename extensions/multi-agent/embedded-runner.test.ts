import { afterEach, describe, expect, it } from "vitest";
import { canUseEmbeddedSubagent } from "./embedded-runner.js";
import { PRESETS } from "./capability.js";

const origElectron = process.versions.electron;
const origSub = process.env.PI_IS_SUBAGENT;

afterEach(() => {
  if (origSub === undefined) delete process.env.PI_IS_SUBAGENT;
  else process.env.PI_IS_SUBAGENT = origSub;
  if (origElectron === undefined) delete (process.versions as { electron?: string }).electron;
  else (process.versions as { electron?: string }).electron = origElectron;
});

describe("canUseEmbeddedSubagent", () => {
  it("allows Electron main sidecar for default profile", () => {
    (process.versions as { electron?: string }).electron = "1.0.0";
    delete process.env.PI_IS_SUBAGENT;
    expect(canUseEmbeddedSubagent(PRESETS.default)).toBe(true);
  });

  it("denies worktree / executor isolation", () => {
    (process.versions as { electron?: string }).electron = "1.0.0";
    expect(canUseEmbeddedSubagent(PRESETS.executor)).toBe(false);
  });

  it("denies subprocess sub-agent (PI_IS_SUBAGENT=1)", () => {
    (process.versions as { electron?: string }).electron = "1.0.0";
    process.env.PI_IS_SUBAGENT = "1";
    expect(canUseEmbeddedSubagent(PRESETS.default)).toBe(false);
  });

  it("denies non-Electron hosts", () => {
    delete (process.versions as { electron?: string }).electron;
    expect(canUseEmbeddedSubagent(PRESETS.default)).toBe(false);
  });
});
