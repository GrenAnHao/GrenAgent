import { describe, expect, it } from 'vitest';
import { clampFontSize, FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN } from './contentFont';

describe('clampFontSize', () => {
  it('keeps 14', () => {
    expect(clampFontSize(14)).toBe(14);
  });

  it('rounds 13.6 up and 13.4 down', () => {
    expect(clampFontSize(13.6)).toBe(14);
    expect(clampFontSize(13.4)).toBe(13);
  });

  it('clamps to 12..17', () => {
    expect(clampFontSize(11)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(99)).toBe(FONT_SIZE_MAX);
  });

  it('coerces numeric strings', () => {
    expect(clampFontSize('14')).toBe(14);
  });

  it('falls back to 14 for garbage', () => {
    expect(clampFontSize(NaN)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(Infinity)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(null)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize(undefined)).toBe(FONT_SIZE_DEFAULT);
    expect(clampFontSize('abc')).toBe(FONT_SIZE_DEFAULT);
  });
});
