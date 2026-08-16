import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SkillClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { fetchRemoteSkills, syncSkills } from "./sync.js";

describe("syncSkills", () => {
  it("writes versioned SKILL.md only under the managed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "tencentdb-skills-"));
    const result = await syncSkills(root, [
      { id: "review", version: 2, markdown: "# Review", resources: [{ path: "templates/a.txt", content: "a" }] },
    ]);
    expect(await readFile(join(root, "review", "SKILL.md"), "utf8")).toContain("# Review");
    expect(await readFile(join(root, "review", "templates", "a.txt"), "utf8")).toBe("a");
    expect(await readFile(join(root, "review", ".version"), "utf8")).toBe("2");
    expect(result.synced).toEqual(["review"]);
  });

  it("rejects resource path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "tencentdb-skills-"));
    await expect(syncSkills(root, [{ id: "review", version: 1, markdown: "x", resources: [{ path: "../escape", content: "x" }] }])).rejects.toThrow(
      "escapes managed root",
    );
  });

  it("loads every active skill across list pages", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({
      skill_id: `skill-${index}`,
    }));
    const second = [{ skill_id: "skill-100" }];
    const list = vi.fn()
      .mockResolvedValueOnce({ items: first, total: 101 })
      .mockResolvedValueOnce({ items: second, total: 101 });
    const get = vi.fn(async ({ skill_id }: { skill_id: string }) => ({
      skill_id,
      version: 1,
      content: `# ${skill_id}`,
      manifest: [],
    }));
    const client = { list, get, readFile: vi.fn() } as unknown as SkillClient;

    const skills = await fetchRemoteSkills(client, {
      teamId: "personal:alice",
      agentId: "coding",
      userId: "alice",
    });

    expect(skills).toHaveLength(101);
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ pagination: { limit: 100, offset: 100 } }));
  });
});
