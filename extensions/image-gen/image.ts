// Image generation via an OpenAI-compatible /images/generations endpoint.
// Returns raw PNG bytes; requires IMAGE_API_KEY or OPENAI_API_KEY.

import { getConfig } from "../_shared/runtime-config.js";
import {
  buildCandidateUrls,
  capabilityError,
  capabilityFetch,
  resolveCapabilityEndpoint,
  type RegistryLike,
} from "../_shared/provider-endpoint.js";

export interface ImageConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  size: string;
}

/** 参考图（图生图 / 编辑）：原始字节 + 文件名 + MIME。 */
export interface ReferenceImage {
  data: Uint8Array;
  name: string;
  type: string;
}

const DISABLED_MSG = "image generation disabled: 请在设置-供应商选择图像供应商并配置其 API Key";

export async function resolveImageConfig(registry: RegistryLike): Promise<ImageConfig> {
  const ep = await resolveCapabilityEndpoint(registry, getConfig("IMAGE_PROVIDER"), getConfig("IMAGE_MODEL"), "gpt-image-1");
  return { ...ep, size: getConfig("IMAGE_SIZE") ?? "1024x1024" };
}

// images/generations 与 images/edits 的响应同构：{ data: [{ b64_json | url }] }。统一解析成字节。
async function extractImageBytes(res: Response, label: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (!res.ok) throw await capabilityError(label, res);

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
  throw new Error(`${label} returned no image data`);
}

export async function generateImage(
  prompt: string,
  config: ImageConfig,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!config.enabled) throw new Error(DISABLED_MSG);

  const res = await capabilityFetch(config.baseUrl, "images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, prompt, n: 1, size: config.size, response_format: "b64_json" }),
    signal,
  });

  return extractImageBytes(res, "image API", signal);
}

/**
 * 携带参考图生成（图生图 / 编辑）：走 OpenAI 兼容的 images/edits（multipart），把参考图作为 image[]
 * 一并上传。无参考图时回退到纯文生图。multipart 不能手动设 content-type（让 fetch 自动带 boundary），
 * 且 FormData body 不可跨候选 URL 复用，故每个候选 URL 重建一次表单。
 */
export async function editImage(
  prompt: string,
  references: ReferenceImage[],
  config: ImageConfig,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!config.enabled) throw new Error(DISABLED_MSG);
  if (references.length === 0) return generateImage(prompt, config, signal);

  const urls = buildCandidateUrls(config.baseUrl, "images/edits");
  let res: Response | undefined;
  for (const url of urls) {
    const form = new FormData();
    form.append("model", config.model);
    form.append("prompt", prompt);
    form.append("size", config.size);
    form.append("n", "1");
    for (const ref of references) {
      form.append("image[]", new Blob([Uint8Array.from(ref.data).buffer], { type: ref.type }), ref.name);
    }
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal,
    });
    if (res.status !== 404 && res.status !== 405) break;
  }

  return extractImageBytes(res as Response, "image edit API", signal);
}
