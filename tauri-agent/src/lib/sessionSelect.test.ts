import { describe, expect, it } from 'vitest';
import type { OpenWorkspaceResult, SessionInfo } from './pi';
import { pickAutoSelected } from './sessionSelect';

const si = (path: string): SessionInfo => ({
  id: path,
  path,
  cwd: null,
  timestamp: null,
  name: null,
});

const owr = (sessionFile: string | null): OpenWorkspaceResult => ({
  sessionFile,
  restoredSession: null,
});

describe('pickAutoSelected', () => {
  it('keeps explicit active (returns null)', () => {
    expect(pickAutoSelected('/a.jsonl', undefined, [])).toBeNull();
  });

  it('prefers openResult.sessionFile when no active', () => {
    expect(pickAutoSelected(null, owr('/o.jsonl'), [])).toBe('/o.jsonl');
  });

  it('falls back to first session', () => {
    expect(pickAutoSelected(null, undefined, [si('/s.jsonl')])).toBe('/s.jsonl');
  });

  it('returns null when nothing to pick', () => {
    expect(pickAutoSelected(null, undefined, [])).toBeNull();
  });
});
