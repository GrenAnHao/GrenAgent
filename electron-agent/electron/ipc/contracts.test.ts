import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, isInvokeRequest } from './contracts';

describe('Electron IPC contracts', () => {
  it('keeps transport channel names stable', () => {
    expect(IPC_CHANNELS.invoke).toBe('gren:invoke');
    expect(IPC_CHANNELS.eventPrefix).toBe('gren:event:');
  });

  it('validates invoke envelopes without accepting malformed payloads', () => {
    expect(isInvokeRequest({ command: 'read_file', args: { path: 'README.md' } })).toBe(true);
    expect(isInvokeRequest({ command: 'read_file' })).toBe(true);
    expect(isInvokeRequest({ command: 42 })).toBe(false);
    expect(isInvokeRequest({ command: 'read_file', args: [] })).toBe(false);
  });
});
