import { describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: (k: string) =>
    ({ MEMORY_EMBED_PROVIDER: "openai", MEMORY_EMBED_MODEL: "text-embedding-3-small" } as Record<string, string>)[k],
}));

import { resolveEmbeddingConfig } from "./embedding.js";

const registry = (key: string | undefined) => ({
  getAll: () => [{ provider: "openai", baseUrl: "https://api.openai.com/v1" }] as never,
  getApiKeyForProvider: async () => key,
});

describe("long-term-memory resolveEmbeddingConfig", () => {
  it("resolves from provider library", async () => {
    const c = await resolveEmbeddingConfig(registry("sk-x") as never);
    expect(c).toMatchObject({ enabled: true, baseUrl: "https://api.openai.com/v1", apiKey: "sk-x", model: "text-embedding-3-small" });
  });

  it("disabled (keyword fallback) when registry is undefined", async () => {
    const c = await resolveEmbeddingConfig(undefined);
    expect(c.enabled).toBe(false);
    expect(c.model).toBe("text-embedding-3-small");
  });
});
