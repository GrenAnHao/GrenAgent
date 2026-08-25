import { describe, expect, it, vi } from "vitest";

import { buildRecallInjection, type MemoryRecallClient } from "./context.js";

describe("buildRecallInjection", () => {
  it("injects L3 into the system prompt and L1/L2 as one bounded custom message", async () => {
    const client: MemoryRecallClient = {
      searchAtomic: vi.fn().mockResolvedValue({
        items: [{ id: "a-1", type: "preference", content: "偏好深色界面", score: 0.91 }],
      }),
      readCore: vi.fn().mockResolvedValue({ content: "用户是独立开发者", created_at: null, updated_at: null }),
      listScenarios: vi.fn().mockResolvedValue({
        entries: [
          { path: "projects/login.md", summary: "登录模块使用 OAuth", created_at: "", updated_at: "" },
        ],
        total: 1,
      }),
    };

    const result = await buildRecallInjection(client, "审查登录模块");

    expect(result.systemPrompt).toContain("<user-persona>");
    expect(result.systemPrompt).toContain("用户是独立开发者");
    expect(result.message?.customType).toBe("tencentdb-memory");
    expect(result.message?.content).toContain("偏好深色界面");
    expect(result.message?.content).toContain("登录模块使用 OAuth");
    expect(client.searchAtomic).toHaveBeenCalledWith({ query: "审查登录模块", limit: 5 });
  });

  it("returns no injection when all memory layers are empty", async () => {
    const client: MemoryRecallClient = {
      searchAtomic: vi.fn().mockResolvedValue({ items: [] }),
      readCore: vi.fn().mockResolvedValue({ content: null, created_at: null, updated_at: null }),
      listScenarios: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    };

    await expect(buildRecallInjection(client, "hello")).resolves.toEqual({});
  });
});
