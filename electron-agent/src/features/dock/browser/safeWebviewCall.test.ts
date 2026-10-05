import { describe, expect, it, vi } from 'vitest';
import { safeWebviewCall } from './safeWebviewCall';

describe('safeWebviewCall', () => {
  it('returns fallback for detached guests and rethrows other errors', () => {
    expect(safeWebviewCall(() => { throw new Error('must be attached to the DOM'); }, 'x')).toBe('x');
    expect(safeWebviewCall(() => { throw new Error('Render frame was disposed'); }, 0)).toBe(0);
    expect(() => safeWebviewCall(() => { throw new Error('boom'); }, 0)).toThrow('boom');
    const onDetached = vi.fn();
    safeWebviewCall(() => { throw new Error('must be attached to the DOM'); }, 1, onDetached);
    expect(onDetached).toHaveBeenCalled();
  });
});
