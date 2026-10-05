import { describe, expect, it } from 'vitest';
import { COMPOSER_COMPACT_BELOW, composerIsCompact } from './composerCompact';

describe('composerIsCompact', () => {
  it('尚未量到宽度时不收成图标', () => {
    expect(composerIsCompact(0)).toBe(false);
  });

  it('窄于阈值时只留图标', () => {
    expect(composerIsCompact(COMPOSER_COMPACT_BELOW - 1)).toBe(true);
  });

  it('足够宽时显示文字', () => {
    expect(composerIsCompact(COMPOSER_COMPACT_BELOW)).toBe(false);
  });
});
