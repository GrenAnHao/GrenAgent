import { describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: (k: string) =>
    ({ KB_EMBED_PROVIDER: "openai", KB_EMBED_MODEL: "text-embedding-3-large" } as Record<string, string>)[k],
}));

import { resolveEmbeddingConfig } from "./embedding.js";

const registry = (key: string | undefined) => ({
  getAll: () => [{ provider: "openai", baseUrl: "https://api.openai.com/v1" }] as never,
  getApiKeyForProvider: async () => key,
});

describe("knowledge-rag resolveEmbeddingConfig", () => {
  it("resolves from provider library", async () => {
    const c = await resolveEmbeddingConfig(registry("sk-x") as never);
    expect(c).toMatchObject({
      enabled: true,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-x",
      model: "text-embedding-3-large",
    });
  });

  it("disabled when no key (keyword fallback)", async () => {
    const c = await resolveEmbeddingConfig(registry(undefined) as never);
    expect(c.enabled).toBe(false);
  });
});
