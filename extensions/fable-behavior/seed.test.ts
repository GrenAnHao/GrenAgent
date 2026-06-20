import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(),
}));

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { FABLE_AGENT_SEED_VERSION, seedFableAgents } from "./seed.js";

describe("seedFableAgents", () => {
  let dir: string;

  afterEach(() => {
    delete process.env.FABLE_BEHAVIOR_SEED_AGENTS;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes templates when absent", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-seed-"));
    vi.mocked(getAgentDir).mockReturnValue(dir);
    seedFableAgents();
    expect(existsSync(join(dir, "agents", "scout.md"))).toBe(true);
    expect(readFileSync(join(dir, "agents", ".fable-behavior-seed-version"), "utf8").trim()).toBe(
      FABLE_AGENT_SEED_VERSION,
    );
  });

  it("skips existing files in if-absent mode", () => {
    dir = mkdtempSync(join(tmpdir(), "pi-seed-"));
    vi.mocked(getAgentDir).mockReturnValue(dir);
    seedFableAgents();
    const scout = join(dir, "agents", "scout.md");
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(scout, "CUSTOM\n", "utf8");
    seedFableAgents();
    expect(readFileSync(scout, "utf8")).toBe("CUSTOM\n");
  });

  it("overwrites when FABLE_BEHAVIOR_SEED_AGENTS=force", () => {
    process.env.FABLE_BEHAVIOR_SEED_AGENTS = "force";
    dir = mkdtempSync(join(tmpdir(), "pi-seed-"));
    vi.mocked(getAgentDir).mockReturnValue(dir);
    seedFableAgents();
    const scout = join(dir, "agents", "scout.md");
    writeFileSync(scout, "CUSTOM\n", "utf8");
    seedFableAgents();
    expect(readFileSync(scout, "utf8")).toContain("read-only scout");
  });
});
