import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  fetchRemoteSkills,
  hasMatchingSkillScope,
  syncSkills,
  type ManagedSkillClient,
} from "./sync.js";

type FixedAssetsPage = Awaited<ReturnType<ManagedSkillClient["metadata"]["listAgentFixedAssetsWithDetail"]>>;
type FixedAsset = FixedAssetsPage["items"][number];

const agent: FixedAssetsPage["agent"] = {
  agent_id: "coding",
  team_id: "personal-alice",
  owner_user_id: "alice",
  prompt: null,
  visibility: "private",
  status: "active",
};

function fixedAsset(assetId: string, assetType: FixedAsset["asset_type"]): FixedAsset {
  return {
    asset_id: assetId,
    asset_type: assetType,
    name: assetId,
    description: null,
    status: "approved",
    visibility: "private",
    injection_mode: "direct",
    priority: 0,
    created_at: "2026-08-17T00:00:00.000Z",
  };
}

function skillDetail(skillId: string): Awaited<ReturnType<ManagedSkillClient["skills"]["get"]>> {
  return {
    skill_id: skillId,
    name: skillId,
    description: skillId,
    version: 1,
    is_head: true,
    status: "active",
    owner_user_id: "alice",
    owner_agent_id: "coding",
    team_id: "personal-alice",
    task_id: "",
    created_at_ms: 0,
    updated_at_ms: 0,
    content: `# ${skillId}`,
    manifest: [],
  };
}

describe("syncSkills", () => {
  it("writes versioned SKILL.md only under the managed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "tencentdb-skills-"));
    const result = await syncSkills(root, "scope-a", [
      { id: "review", version: 2, markdown: "# Review", resources: [{ path: "templates/a.txt", content: "a" }] },
    ]);
    expect(await readFile(join(root, "review", "SKILL.md"), "utf8")).toContain("# Review");
    expect(await readFile(join(root, "review", "templates", "a.txt"), "utf8")).toBe("a");
    expect(await readFile(join(root, "review", ".version"), "utf8")).toBe("2");
    expect(result.synced).toEqual(["review"]);
    expect(await hasMatchingSkillScope(root, "scope-a")).toBe(true);
    expect(await hasMatchingSkillScope(root, "scope-b")).toBe(false);
  });

  it("rejects resource path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "tencentdb-skills-"));
    await expect(syncSkills(root, "scope-a", [{ id: "review", version: 1, markdown: "x", resources: [{ path: "../escape", content: "x" }] }])).rejects.toThrow(
      "escapes managed root",
    );
  });

  it("never reuses managed Skills from a different connection scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "tencentdb-skills-"));
    await syncSkills(root, "remote:endpoint-a:team-a", [
      { id: "private-a", version: 1, markdown: "# Team A", resources: [] },
    ]);

    await syncSkills(root, "remote:endpoint-b:team-b", [
      { id: "private-b", version: 1, markdown: "# Team B", resources: [] },
    ]);

    await expect(readFile(join(root, "private-a", "SKILL.md"), "utf8")).rejects.toThrow();
    expect(await readFile(join(root, "private-b", "SKILL.md"), "utf8")).toContain("# Team B");
    expect(await hasMatchingSkillScope(root, "remote:endpoint-a:team-a")).toBe(false);
    expect(await hasMatchingSkillScope(root, "remote:endpoint-b:team-b")).toBe(true);
  });

  it("loads only Skill assets fixed to the current agent across binding pages", async () => {
    const first = Array.from({ length: 100 }, (_, index) => fixedAsset(`skill-${index}`, "skill"));
    const second = [
      fixedAsset("shared-skill", "skill"),
      fixedAsset("wiki-1", "llm_wiki"),
    ];
    const listAgentFixedAssetsWithDetail = vi.fn<ManagedSkillClient["metadata"]["listAgentFixedAssetsWithDetail"]>()
      .mockResolvedValueOnce({ agent, items: first, total: 101, limit: 100, offset: 0 })
      .mockResolvedValueOnce({ agent, items: second, total: 101, limit: 100, offset: 100 });
    const get = vi.fn<ManagedSkillClient["skills"]["get"]>(async ({ skill_id }) => skillDetail(skill_id));
    const client: ManagedSkillClient = {
      skills: { get, readFile: vi.fn<ManagedSkillClient["skills"]["readFile"]>() },
      metadata: { listAgentFixedAssetsWithDetail },
    };

    const skills = await fetchRemoteSkills(client, {
      teamId: "personal-alice",
      agentId: "coding",
      userId: "alice",
    });

    expect(skills).toHaveLength(101);
    expect(skills.at(-1)?.id).toBe("shared-skill");
    expect(listAgentFixedAssetsWithDetail).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 100, offset: 100 }));
    expect(get).not.toHaveBeenCalledWith(expect.objectContaining({ skill_id: "wiki-1" }));
  });

  it("does not load owner Skills that are no longer fixed to the agent", async () => {
    const get = vi.fn<ManagedSkillClient["skills"]["get"]>();
    const client: ManagedSkillClient = {
      skills: { get, readFile: vi.fn<ManagedSkillClient["skills"]["readFile"]>() },
      metadata: {
        listAgentFixedAssetsWithDetail: vi.fn<ManagedSkillClient["metadata"]["listAgentFixedAssetsWithDetail"]>()
          .mockResolvedValue({ agent, items: [], total: 0, limit: 100, offset: 0 }),
      },
    };

    await expect(fetchRemoteSkills(client, {
      teamId: "personal-alice",
      agentId: "coding",
      userId: "alice",
    })).resolves.toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});
