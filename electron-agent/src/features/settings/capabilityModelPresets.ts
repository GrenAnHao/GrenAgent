export type Capability = 'image' | 'embedding' | 'tts';

/** 各供应商常用的 image/embedding/tts 模型建议（仅 UI 建议，可手填覆盖）。 */
export const CAPABILITY_MODEL_PRESETS: Record<string, Partial<Record<Capability, string[]>>> = {
  openai: {
    image: ['gpt-image-1', 'dall-e-3'],
    embedding: ['text-embedding-3-small', 'text-embedding-3-large'],
    tts: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
  },
};

export function suggestModels(provider: string, capability: Capability): string[] {
  return CAPABILITY_MODEL_PRESETS[provider]?.[capability] ?? [];
}
