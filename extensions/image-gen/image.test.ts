import { describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: (k: string) =>
    ({ IMAGE_PROVIDER: "openai", IMAGE_MODEL: "gpt-image-1", IMAGE_SIZE: "512x512" } as Record<string, string>)[k],
}));

import { resolveImageConfig } from "./image.js";

const registry = (key: string | undefined) => ({
  getAll: () => [{ provider: "openai", baseUrl: "https://api.openai.com/v1" }] as never,
  getApiKeyForProvider: async () => key,
});

describe("resolveImageConfig", () => {
  it("resolves baseUrl/key/model/size from provider library", async () => {
    const c = await resolveImageConfig(registry("sk-x") as never);
    expect(c).toMatchObject({
      enabled: true,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-x",
      model: "gpt-image-1",
      size: "512x512",
    });
  });

  it("disabled when provider has no key", async () => {
    const c = await resolveImageConfig(registry(undefined) as never);
    expect(c.enabled).toBe(false);
    expect(c.size).toBe("512x512");
  });
});
