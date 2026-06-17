// Resolve an OpenAI-compatible endpoint (baseUrl + apiKey) for a capability
// (image / tts / embedding) from the provider library, via the ModelRegistry.
//
// baseUrl is taken from any model of the chosen provider (built-in providers
// carry built-in models; custom providers carry models.json baseUrl). apiKey is
// resolved through getApiKeyForProvider (auth.json + models.json). This reuses
// Phase-1 credentials and needs no duplicated default base-URL table.

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface CapabilityEndpoint {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type RegistryLike = Pick<ModelRegistry, "getAll" | "getApiKeyForProvider">;

export async function resolveCapabilityEndpoint(
  registry: RegistryLike,
  provider: string | undefined,
  model: string | undefined,
  fallbackModel: string,
): Promise<CapabilityEndpoint> {
  const p = (provider ?? "").trim();
  const baseUrl = (registry.getAll().find((m) => m.provider === p)?.baseUrl ?? "").replace(/\/+$/, "");
  const apiKey = p ? ((await registry.getApiKeyForProvider(p)) ?? "") : "";
  const resolved = (model ?? "").trim() || fallbackModel;
  return { enabled: apiKey.length > 0 && baseUrl.length > 0, baseUrl, apiKey, model: resolved };
}
