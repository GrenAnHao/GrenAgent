import { describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({
  getConfig: (k: string) =>
    ({ TTS_PROVIDER: "openai", TTS_MODEL: "tts-1", TTS_VOICE: "nova", TTS_FORMAT: "wav" } as Record<string, string>)[k],
}));

import { resolveTtsConfig } from "./tts.js";

const registry = (key: string | undefined) => ({
  getAll: () => [{ provider: "openai", baseUrl: "https://api.openai.com/v1" }] as never,
  getApiKeyForProvider: async () => key,
});

describe("resolveTtsConfig", () => {
  it("resolves endpoint + behavior fields", async () => {
    const c = await resolveTtsConfig(registry("sk-x") as never);
    expect(c).toMatchObject({
      enabled: true,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-x",
      model: "tts-1",
      voice: "nova",
      format: "wav",
    });
  });

  it("disabled when no key", async () => {
    const c = await resolveTtsConfig(registry(undefined) as never);
    expect(c.enabled).toBe(false);
  });
});
