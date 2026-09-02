import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, isInvokeRequest, type ThreadDto } from './contracts';

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

  it('exposes serializable app server DTO contracts', () => {
    const thread: ThreadDto = { id: 't', projectId: 'p', workspace: '/w', status: 'active', createdAt: 1, updatedAt: 1 };
    expect(JSON.parse(JSON.stringify(thread))).toEqual(thread);
  });
});
