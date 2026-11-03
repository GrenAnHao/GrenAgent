import { describe, expect, it } from 'vitest';
import { providerOfModelValue, scrubLinkedModelSettings } from './scrubLinkedModelSettings';

describe('providerOfModelValue', () => {
  it('splits on the first slash', () => {
    expect(providerOfModelValue('gone/deepseek-flash')).toBe('gone');
    expect(providerOfModelValue('openai/gpt-4o/mini')).toBe('openai');
    expect(providerOfModelValue('plain')).toBe('');
  });
});

describe('scrubLinkedModelSettings', () => {
  it('clears model / capability / allowlist entries for the deleted provider and keeps others', () => {
    const { next, changed, clearedKeys } = scrubLinkedModelSettings(
      {
        titleModel: 'gone/flash',
        AUTO_TITLE: '1',
        IMAGE_PROVIDER: 'gone',
        IMAGE_MODEL: 'img-1',
        TTS_PROVIDER: 'openai',
        TTS_MODEL: 'tts-1',
        SUBAGENT_MODEL: 'gone/flash',
        SUBAGENT_MODEL_CHEAP: 'openai/gpt-4o-mini',
        SUBAGENT_MODEL_STRONG: 'gone/r1',
        SUBAGENT_MODEL_ALLOWLIST: JSON.stringify(['gone/flash', 'openai/gpt-4o']),
      },
      ['gone'],
    );

    expect(changed).toBe(true);
    expect(next.titleModel).toBe('');
    expect(next.IMAGE_PROVIDER).toBe('');
    expect(next.IMAGE_MODEL).toBe('');
    expect(next.TTS_PROVIDER).toBe('openai');
    expect(next.TTS_MODEL).toBe('tts-1');
    expect(next.SUBAGENT_MODEL).toBe('');
    expect(next.SUBAGENT_MODEL_CHEAP).toBe('openai/gpt-4o-mini');
    expect(next.SUBAGENT_MODEL_STRONG).toBe('');
    expect(next.SUBAGENT_MODEL_ALLOWLIST).toBe(JSON.stringify(['openai/gpt-4o']));
    expect(next.AUTO_TITLE).toBe('1');
    expect(clearedKeys).toEqual([
      'titleModel',
      'IMAGE_PROVIDER',
      'IMAGE_MODEL',
      'SUBAGENT_MODEL',
      'SUBAGENT_MODEL_STRONG',
      'SUBAGENT_MODEL_ALLOWLIST',
    ]);
  });

  it('is a no-op when nothing points at the deleted provider', () => {
    const settings = { titleModel: 'openai/gpt-4o', AUTO_TITLE: '1' };
    expect(scrubLinkedModelSettings(settings, ['gone'])).toEqual({
      next: settings,
      changed: false,
      clearedKeys: [],
    });
  });

  it('clears defaultSessionModel when it points at the deleted provider', () => {
    const { next, changed, clearedKeys } = scrubLinkedModelSettings(
      { defaultSessionModel: 'gone/flash', titleModel: 'openai/gpt-4o' },
      ['gone'],
    );
    expect(changed).toBe(true);
    expect(next.defaultSessionModel).toBe('');
    expect(next.titleModel).toBe('openai/gpt-4o');
    expect(clearedKeys).toContain('defaultSessionModel');
    expect(clearedKeys).not.toContain('titleModel');
  });

  it('clears enhancePromptModel when it points at the deleted provider', () => {
    const { next, changed, clearedKeys } = scrubLinkedModelSettings(
      { enhancePromptModel: 'gone/flash', titleModel: 'openai/gpt-4o' },
      ['gone'],
    );
    expect(changed).toBe(true);
    expect(next.enhancePromptModel).toBe('');
    expect(next.titleModel).toBe('openai/gpt-4o');
    expect(clearedKeys).toContain('enhancePromptModel');
  });
});

describe('scrubLinkedModelSettings — ultra keys', () => {
  it('clears Ultra role / default keys pointing at the deleted provider and edits the Ultra allowlist', () => {
    const { next, changed, clearedKeys } = scrubLinkedModelSettings(
      {
        ULTRA_SUBAGENT_MODEL: 'gone/planner',
        ULTRA_SUBAGENT_MODEL_SCOUT: 'gone/flash',
        ULTRA_SUBAGENT_MODEL_WORKER: 'openai/gpt-5',
        ULTRA_SUBAGENT_MODEL_PLANNER: 'gone/gpt-5',
        ULTRA_SUBAGENT_MODEL_REVIEWER: 'gone/critic',
        ULTRA_SUBAGENT_MODEL_ALLOWLIST: JSON.stringify(['gone/flash', 'openai/gpt-5']),
        SUBAGENT_MODEL: 'openai/gpt-4o',
      },
      ['gone'],
    );

    expect(changed).toBe(true);
    expect(next.ULTRA_SUBAGENT_MODEL).toBe('');
    expect(next.ULTRA_SUBAGENT_MODEL_SCOUT).toBe('');
    expect(next.ULTRA_SUBAGENT_MODEL_WORKER).toBe('openai/gpt-5');
    expect(next.ULTRA_SUBAGENT_MODEL_PLANNER).toBe('');
    expect(next.ULTRA_SUBAGENT_MODEL_REVIEWER).toBe('');
    expect(next.ULTRA_SUBAGENT_MODEL_ALLOWLIST).toBe(JSON.stringify(['openai/gpt-5']));
    // 普通键不受 Ultra 影响，反之亦然
    expect(next.SUBAGENT_MODEL).toBe('openai/gpt-4o');
    expect(clearedKeys).toEqual([
      'ULTRA_SUBAGENT_MODEL',
      'ULTRA_SUBAGENT_MODEL_SCOUT',
      'ULTRA_SUBAGENT_MODEL_PLANNER',
      'ULTRA_SUBAGENT_MODEL_REVIEWER',
      'ULTRA_SUBAGENT_MODEL_ALLOWLIST',
    ]);
  });
});
