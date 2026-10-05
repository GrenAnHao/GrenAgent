import { describe, expect, it } from 'vitest';
import { actionMap, DEFAULT_LEFT_ACTIONS } from '../config';

describe('input extension actions', () => {
  it('does not register the retired knowledge action', () => {
    expect('kbAdd' in actionMap).toBe(false);
    expect(DEFAULT_LEFT_ACTIONS).not.toContain('kbAdd');
  });

  it('does not show the retired prompt-prefill buttons', () => {
    for (const key of ['fileUpload', 'webSearch', 'generateImage', 'speak']) {
      expect(key in actionMap).toBe(false);
      expect(DEFAULT_LEFT_ACTIONS).not.toContain(key);
    }
  });
});
