import { describe, expect, it } from 'vitest';
import { clampBrowserViewport, parseViewportDimension } from './browserViewport';

describe('clampBrowserViewport', () => {
  it('keeps a phone-sized viewport and clamps out-of-range values', () => {
    expect(clampBrowserViewport({ width: 393, height: 852 })).toEqual({ width: 393, height: 852 });
    expect(clampBrowserViewport({ width: 10, height: 9999 })).toEqual({ width: 320, height: 2160 });
  });
});

describe('parseViewportDimension', () => {
  it('accepts integers inside the safe range', () => {
    expect(parseViewportDimension('1280', 'width')).toBe(1280);
    expect(parseViewportDimension(' 720 ', 'height')).toBe(720);
    expect(parseViewportDimension('12.5', 'width')).toBeNull();
    expect(parseViewportDimension('100', 'width')).toBeNull();
  });
});
