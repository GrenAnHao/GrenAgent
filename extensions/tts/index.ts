// tts: synthesize speech from text via an OpenAI-compatible audio API.
// Saves an audio file under <cwd>/.pi/audio/ and returns its path.

import { projectCwd } from "../_shared/session-cwd.js";
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
    promptSnippet: "Synthesize speech from text.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to speak" }),
      voice: Type.Optional(Type.String({ description: "Voice name (default from TTS_VOICE, e.g. alloy/echo/nova)" })),
      instruct: Type.Optional(
        Type.String({
          description:
            "Natural-language delivery direction — tone, emotion, scene, pace, character. " +
            "E.g. 'excited and upbeat', 'calm narrator in a quiet room', 'young male tone'. " +
            "Maps to OpenAI gpt-4o-mini-tts `instructions`; for MiMo voice-design models it designs the voice.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const text = (params.text ?? "").trim();
      if (!text) throw new Error("text must be non-empty");
      const instruct = params.instruct?.trim() || undefined;

      const config = await resolveTtsConfig(ctx.modelRegistry);
      const cfg = params.voice ? { ...config, voice: params.voice } : config;
      const bytes = await synthesizeSpeech(text, cfg, signal ?? undefined, instruct);

      const dir = join(projectCwd(ctx), ".pi", "audio");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `speech_${Date.now()}.${config.format}`);
      writeFileSync(path, bytes);

      return {
        content: [{ type: "text", text: `Synthesized speech (${bytes.length} bytes) saved to ${path}` }],
        details: {
          path,
          bytes: bytes.length,
          voice: cfg.voice,
          model: config.model,
          format: config.format,
          ...(instruct ? { instruct } : {}),
        },
      };
    },
  });
}
