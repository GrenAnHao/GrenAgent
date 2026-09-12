import { describe, expect, it } from 'vitest';
import { CHAT_CONTENT_WIDTH } from './chatStyles';

describe('CHAT_CONTENT_WIDTH', () => {
  it('matches the Codex-aligned content column expression', () => {
    expect(CHAT_CONTENT_WIDTH).toBe('min(100%, 1120px, max(760px, 86%))');
  });
});
