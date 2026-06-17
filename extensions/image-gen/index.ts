// image-gen: generate images from text prompts via an OpenAI-compatible
// images API. Saves a PNG under <cwd>/.pi/images/ and returns the path.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { generateImage, resolveImageConfig } from "./image.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "generate_image",
    label: "Generate Image",
    description:
      "Generate an image from a text prompt using an OpenAI-compatible images API. " +
      "Saves a PNG under .pi/images/ and returns its file path.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Description of the image to generate" }),
      size: Type.Optional(Type.String({ description: "Image size, e.g. 1024x1024 (defaults to IMAGE_SIZE)" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const prompt = (params.prompt ?? "").trim();
      if (!prompt) throw new Error("prompt must be non-empty");

      const config = await resolveImageConfig(ctx.modelRegistry);
      const bytes = await generateImage(prompt, { ...config, size: params.size ?? config.size }, signal ?? undefined);

      const dir = join(ctx.cwd, ".pi", "images");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `img_${Date.now()}.png`);
      writeFileSync(path, bytes);

      return {
        content: [{ type: "text", text: `Generated image (${bytes.length} bytes) saved to ${path}` }],
        details: { path, bytes: bytes.length, model: config.model, size: params.size ?? config.size },
      };
    },
  });
}
