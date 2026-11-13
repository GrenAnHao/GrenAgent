import { describe, expect, it, vi } from 'vitest';
import { acquireSingleInstanceLock } from './singleInstance';

describe('acquireSingleInstanceLock', () => {
  it('skips the lock entirely in tests', () => {
    const app = { requestSingleInstanceLock: vi.fn(() => false), quit: vi.fn() };
    expect(acquireSingleInstanceLock(app, true)).toBe(true);
    expect(app.requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('starts the app when the lock is acquired', () => {
    const app = { requestSingleInstanceLock: vi.fn(() => true), quit: vi.fn() };
    expect(acquireSingleInstanceLock(app, false)).toBe(true);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('quits a second instance and does not start it', () => {
    const app = { requestSingleInstanceLock: vi.fn(() => false), quit: vi.fn() };
    expect(acquireSingleInstanceLock(app, false)).toBe(false);
    expect(app.quit).toHaveBeenCalledOnce();
  });
});
