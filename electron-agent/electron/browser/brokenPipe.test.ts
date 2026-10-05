import { describe, expect, it, vi } from 'vitest';
import {
  handleUncaughtException,
  ignoreBrokenPipeStreamError,
  isBrokenPipeError,
} from './brokenPipe';

describe('isBrokenPipeError', () => {
  it('only matches EPIPE', () => {
    expect(isBrokenPipeError(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).toBe(true);
    expect(isBrokenPipeError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isBrokenPipeError('EPIPE')).toBe(false);
  });
});

describe('ignoreBrokenPipeStreamError', () => {
  it('swallows EPIPE and rethrows other stream errors', () => {
    expect(() => {
      ignoreBrokenPipeStreamError(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
    }).not.toThrow();
    expect(() => {
      ignoreBrokenPipeStreamError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    }).toThrow(/reset/);
  });
});

describe('handleUncaughtException', () => {
  it('does not report EPIPE as fatal', () => {
    const onFatal = vi.fn();
    handleUncaughtException(Object.assign(new Error('broken pipe, write'), { code: 'EPIPE' }), onFatal);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('forwards other uncaught exceptions', () => {
    const onFatal = vi.fn();
    const error = new Error('real failure');
    handleUncaughtException(error, onFatal);
    expect(onFatal).toHaveBeenCalledWith(error);
  });
});
