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

  it('skips an archived session restored by pi and picks the newest visible one', () => {
    const sessions = [{ ...si('/arch.jsonl'), archived: true }, si('/s.jsonl')];
    expect(pickAutoSelected(null, owr('/ARCH.jsonl'), sessions)).toBe('/s.jsonl');
  });

  it('picks nothing when every session is archived', () => {
    expect(pickAutoSelected(null, owr('/arch.jsonl'), [{ ...si('/arch.jsonl'), archived: true }])).toBeNull();
  });
});
