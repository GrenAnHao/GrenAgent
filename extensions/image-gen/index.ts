// image-gen: generate images from text prompts via an OpenAI-compatible
// images API. Saves a PNG under <cwd>/.pi/images/ and returns the path.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { editImage, generateImage, resolveImageConfig, type ReferenceImage } from "./image.js";

// 一次最多并排出图数：避免误传大数刷爆供应商配额；并行各发一次 n:1 请求，兼容所有供应商
//（含 DALL-E 3 这类不支持 n>1 的）。
const MAX_COUNT = 4;

function mimeOf(p: string): string {
  const ext = extname(p).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

// 读参考图（相对 cwd 或绝对路径）成字节，供图生图上传。
function readReferences(cwd: string, paths: string[]): ReferenceImage[] {
  return paths
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const abs = isAbsolute(p) ? p : resolve(cwd, p);
      return { data: new Uint8Array(readFileSync(abs)), name: basename(abs), type: mimeOf(abs) };
    });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "generate_image",
    label: "Generate Image",
    description:
      "Generate one or more images from a text prompt using an OpenAI-compatible images API. " +
      "Saves PNG(s) under .pi/images/ and returns their file paths. " +
      "Pick size and count yourself based on the request — e.g. a portrait poster (1024x1792), " +
      `or several options/variations at once (count up to ${MAX_COUNT}). ` +
      "Pass reference_images (image-to-image / edit) to guide the result with existing images.",
    promptSnippet: "Generate images from a text prompt.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Description of the image to generate" }),
      size: Type.Optional(
        Type.String({
          description:
            "Image size WxH: 1024x1024 (square), 1024x1792 (portrait), 1792x1024 (landscape). Defaults to IMAGE_SIZE.",
        }),
      ),
      count: Type.Optional(
        Type.Number({
          description: `How many images to generate (1-${MAX_COUNT}, default 1). Use >1 for variations/options shown side by side.`,
        }),
      ),
      reference_images: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Reference image file path(s), relative to cwd or absolute, to guide generation (image-to-image / edit). Omit for pure text-to-image.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const prompt = (params.prompt ?? "").trim();
      if (!prompt) throw new Error("prompt must be non-empty");

      const config = await resolveImageConfig(ctx.modelRegistry);
      const size = params.size ?? config.size;
      const count = Math.min(Math.max(Math.round(params.count ?? 1), 1), MAX_COUNT);
      const references = Array.isArray(params.reference_images)
        ? readReferences(ctx.cwd, params.reference_images)
        : [];

      const dir = join(ctx.cwd, ".pi", "images");
      mkdirSync(dir, { recursive: true });

      const stamp = Date.now();
      // 并行各发一次单图请求（兼容不支持 n>1 的供应商），任一失败则整体失败。
      // 带参考图走 images/edits（图生图），否则走 images/generations（文生图）。
      const runOne = () =>
        references.length > 0
          ? editImage(prompt, references, { ...config, size }, signal ?? undefined)
          : generateImage(prompt, { ...config, size }, signal ?? undefined);
      const images = await Promise.all(Array.from({ length: count }, runOne));
      const paths = images.map((bytes, i) => {
        const path = join(dir, count > 1 ? `img_${stamp}_${i + 1}.png` : `img_${stamp}.png`);
        writeFileSync(path, bytes);
        return path;
      });
      const totalBytes = images.reduce((sum, b) => sum + b.length, 0);

      return {
        content: [
          {
            type: "text",
            text:
              count > 1
                ? `Generated ${count} images (${totalBytes} bytes) saved to ${dir}`
                : `Generated image (${totalBytes} bytes) saved to ${paths[0]}`,
          },
        ],
        // path 保留单图字段（向后兼容）；paths 为完整列表，前端多图并排展示。
        details: { path: paths[0], paths, model: config.model, size, count, references: references.length },
      };
    },
  });
}
