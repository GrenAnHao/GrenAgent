import { describe, expect, it } from 'vitest';
import { migratePhase2 } from './phase2Migration';

describe('migratePhase2', () => {
  it('migrates openai-based image to provider=openai + auth key', () => {
    const r = migratePhase2({ IMAGE_API_KEY: 'sk-a', IMAGE_MODEL: 'gpt-image-1' }, '{}', '{}');
    expect(r.changed).toBe(true);
    expect(r.nextSettings.IMAGE_PROVIDER).toBe('openai');
    expect(r.nextSettings.IMAGE_MODEL).toBe('gpt-image-1');
    expect(r.nextSettings.IMAGE_API_KEY).toBeUndefined();
    expect(JSON.parse(r.authJson).openai.key).toBe('sk-a');
  });

  it('maps a preset baseUrl to its provider id', () => {
    const r = migratePhase2(
      { TTS_API_KEY: 'k', TTS_BASE_URL: 'https://api.deepseek.com', TTS_MODEL: 'x' },
      '{}',
      '{}',
    );
    expect(r.nextSettings.TTS_PROVIDER).toBe('deepseek');
    expect(JSON.parse(r.authJson).deepseek.key).toBe('k');
  });

  it('ignores retired knowledge and memory capability settings', () => {
    const r = migratePhase2(
      {
        KB_EMBED_API_KEY: 'kb-key',
        KB_EMBED_BASE_URL: 'https://kb.example/v1',
        KB_EMBED_MODEL: 'kb-model',
        MEMORY_EMBED_API_KEY: 'memory-key',
        MEMORY_EMBED_MODEL: 'memory-model',
      },
      '{}',
      '{}',
    );
    expect(r.changed).toBe(false);
    expect(r.nextSettings.KB_EMBED_PROVIDER).toBeUndefined();
    expect(r.nextSettings.MEMORY_EMBED_PROVIDER).toBeUndefined();
    expect(JSON.parse(r.modelsJson).providers).toEqual({});
  });

  it('is idempotent: no old key or already migrated → no change', () => {
    expect(migratePhase2({ IMAGE_PROVIDER: 'openai' }, '{}', '{}').changed).toBe(false);
    expect(migratePhase2({}, '{}', '{}').changed).toBe(false);
  });
});
