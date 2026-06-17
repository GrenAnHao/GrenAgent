// tts: synthesize speech from text via an OpenAI-compatible audio API.
// Saves an audio file under <cwd>/.pi/audio/ and returns its path.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveTtsConfig, synthesizeSpeech } from "./tts.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "speak",
    label: "Text to Speech",
    description:
      "Synthesize speech from text using an OpenAI-compatible audio API. " +
      "Saves an audio file under .pi/audio/ and returns its path (play it with your OS player).",
    parameters: Type.Object({
      text: Type.String({ description: "Text to speak" }),
      voice: Type.Optional(Type.String({ description: "Voice name (default from TTS_VOICE, e.g. alloy/echo/nova)" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const text = (params.text ?? "").trim();
      if (!text) throw new Error("text must be non-empty");

      const config = await resolveTtsConfig(ctx.modelRegistry);
      const cfg = params.voice ? { ...config, voice: params.voice } : config;
      const bytes = await synthesizeSpeech(text, cfg, signal ?? undefined);

      const dir = join(ctx.cwd, ".pi", "audio");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `speech_${Date.now()}.${config.format}`);
      writeFileSync(path, bytes);

      return {
        content: [{ type: "text", text: `Synthesized speech (${bytes.length} bytes) saved to ${path}` }],
        details: { path, bytes: bytes.length, voice: cfg.voice, model: config.model, format: config.format },
      };
    },
  });
}
