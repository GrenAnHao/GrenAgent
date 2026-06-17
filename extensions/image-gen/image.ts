// Image generation via an OpenAI-compatible /images/generations endpoint.
// Returns raw PNG bytes; requires IMAGE_API_KEY or OPENAI_API_KEY.

import { getConfig } from "../_shared/runtime-config.js";
import { resolveCapabilityEndpoint, type RegistryLike } from "../_shared/provider-endpoint.js";

export interface ImageConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  size: string;
}

export async function resolveImageConfig(registry: RegistryLike): Promise<ImageConfig> {
  const ep = await resolveCapabilityEndpoint(registry, getConfig("IMAGE_PROVIDER"), getConfig("IMAGE_MODEL"), "gpt-image-1");
  return { ...ep, size: getConfig("IMAGE_SIZE") ?? "1024x1024" };
}

export async function generateImage(
  prompt: string,
  config: ImageConfig,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!config.enabled) throw new Error("image generation disabled: 请在设置-供应商选择图像供应商并配置其 API Key");

  const res = await fetch(`${config.baseUrl}/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, prompt, n: 1, size: config.size, response_format: "b64_json" }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`image API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }

  const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const item = json.data?.[0];

  if (item?.b64_json) {
    return Uint8Array.from(Buffer.from(item.b64_json, "base64"));
  }
  if (item?.url) {
    const img = await fetch(item.url, { signal });
    if (!img.ok) throw new Error(`failed to download generated image: HTTP ${img.status}`);
    return new Uint8Array(await img.arrayBuffer());
  }
  throw new Error("image API returned no image data");
}
