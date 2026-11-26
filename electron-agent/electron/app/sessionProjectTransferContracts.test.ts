import { describe, expect, it } from 'vitest';
import { parseSessionProjectTransferRequest } from './sessionProjectTransferContracts.js';

const base = { sourceWorkspace: 'D:/src', sessionPath: 'D:/agent/sessions/--src--/2026-01-01T00-00-00_a.jsonl' };
const commit = {
  ...base,
  action: 'commit',
  operationId: 'op-1',
  ticket: 'ticket-1',
  expectedSessionId: 'session-a',
  expectedLeafId: null,
  expectedRevision: 'host:1',
};

describe('session project transfer contract', () => {
  it('preview accepts only explicit sessionPath and targetWorkspace', () => {
    const request = parseSessionProjectTransferRequest({ ...base, action: 'preview', targetWorkspace: 'D:/dst' });
    expect(request).toEqual({ ...base, action: 'preview', targetWorkspace: 'D:/dst' });
    expect(() => parseSessionProjectTransferRequest({ ...base, action: 'preview' })).toThrow(/targetWorkspace/);
  });

  it('commit keeps the host ticket, operation id and null-root identity', () => {
    const request = parseSessionProjectTransferRequest(commit);
    expect(request).toMatchObject({ action: 'commit', expectedLeafId: null, expectedRevision: 'host:1', ticket: 'ticket-1' });
    expect(parseSessionProjectTransferRequest({ ...commit, expectedLeafId: 'entry-9' })).toMatchObject({ expectedLeafId: 'entry-9' });
  });

  it('commit rejects a missing identity, leaf or revision instead of defaulting them', () => {
    for (const key of ['expectedSessionId', 'expectedLeafId', 'expectedRevision', 'ticket', 'operationId'] as const) {
      const raw: Record<string, unknown> = { ...commit };
      delete raw[key];
      expect(() => parseSessionProjectTransferRequest(raw), key).toThrow();
    }
    expect(() => parseSessionProjectTransferRequest({ ...commit, expectedLeafId: '' })).toThrow(/expectedLeafId/);
  });

  it('rejects renderer-supplied after-image, backup, journal and snapshot paths', () => {
    for (const key of ['afterImage', 'after_image', 'beforeImage', 'backup', 'backupPath', 'journal', 'journalPath', 'manifest', 'snapshot', 'rollback', 'recoveryPath', 'evidence']) {
      expect(() => parseSessionProjectTransferRequest({ ...commit, [key]: 'D:/tmp/x' }), key).toThrow(/rejects renderer-supplied/i);
    }
    expect(() => parseSessionProjectTransferRequest({ ...base, action: 'preview', targetWorkspace: 'D:/dst', afterImagePath: 'D:/tmp/x' }))
      .toThrow(/rejects renderer-supplied/i);
  });

  it('rejects any other field outside the per-action whitelist', () => {
    expect(() => parseSessionProjectTransferRequest({ ...commit, overwrite: true })).toThrow(/Unexpected/);
    expect(() => parseSessionProjectTransferRequest({ ...commit, targetWorkspace: 'D:/other' })).toThrow(/Unexpected/);
    expect(() => parseSessionProjectTransferRequest({ ...base, action: 'preview', targetWorkspace: 'D:/dst', ticket: 't' })).toThrow(/Unexpected/);
  });

  it('status and retry-open accept only operationId plus the explicit session', () => {
    for (const action of ['status', 'retry-open'] as const) {
      const request = parseSessionProjectTransferRequest({ ...base, action, operationId: 'op-1' });
      expect(request).toEqual({ ...base, action, operationId: 'op-1' });
      expect(() => parseSessionProjectTransferRequest({ ...base, action, operationId: 'op-1', targetWorkspace: 'D:/dst' })).toThrow(/Unexpected/);
    }
  });

  it('rejects unknown actions and blank source/session values', () => {
    expect(() => parseSessionProjectTransferRequest({ ...base, action: 'recover', operationId: 'op-1' })).toThrow(/Invalid/);
    expect(() => parseSessionProjectTransferRequest({ ...base, action: 'status', operationId: '' })).toThrow(/operationId/);
    expect(() => parseSessionProjectTransferRequest({ ...commit, sourceWorkspace: '  ' })).toThrow(/sourceWorkspace/);
    expect(() => parseSessionProjectTransferRequest({ ...commit, sessionPath: '' })).toThrow(/sessionPath/);
  });
});
