// Embedding backend for the long-term-memory extension.
// OpenAI-compatible /embeddings endpoint; falls back to keyword search when no
// key is configured. Shares OPENAI_API_KEY with other extensions by default.

import { getConfig } from "../_shared/runtime-config.js";
import { resolveCapabilityEndpoint, type RegistryLike } from "../_shared/provider-endpoint.js";

export interface EmbeddingConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function resolveEmbeddingConfig(registry: RegistryLike | undefined): Promise<EmbeddingConfig> {
  if (!registry) {
    return Promise.resolve({
      enabled: false,
      baseUrl: "",
      apiKey: "",
      model: getConfig("MEMORY_EMBED_MODEL") ?? "text-embedding-3-small",
    });
  }
  return resolveCapabilityEndpoint(registry, getConfig("MEMORY_EMBED_PROVIDER"), getConfig("MEMORY_EMBED_MODEL"), "text-embedding-3-small");
}

export async function embedTexts(
  texts: string[],
  config: EmbeddingConfig,
  signal?: AbortSignal,
): Promise<number[][]> {
  if (!config.enabled) throw new Error("embedding disabled: 请在设置-记忆选择 embedding 供应商");
  if (texts.length === 0) return [];

  const res = await fetch(`${config.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model: config.model, input: texts }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`embedding API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }

  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data.map((d) => d.embedding);
}
