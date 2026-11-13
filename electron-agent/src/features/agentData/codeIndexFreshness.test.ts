import { describe, expect, it } from 'vitest';
import { codeIndexPresentation, codeIndexWatcherPending, indexFreshness } from './codeIndexPresentation';
import type { CodeGraphStatus } from '../../lib/agentData';

const base: CodeGraphStatus = { workspace: 'D:/repo', connected: true, indexed: true, state: 'ready', phase: 'idle' };
const at = (patch: Partial<CodeGraphStatus>): CodeGraphStatus => ({ ...base, ...patch });

describe('index availability and freshness are separate', () => {
  it('keeps the index queryable when the last sync failed but the index is readable', () => {
    const view = codeIndexPresentation({ status: at({ state: 'failed', message: 'sync blew up', consecutiveFailures: 2 }), checking: false });
    expect(view.canQuery).toBe(true);
    expect(view.freshness).toBe('stale');
    expect(view.banner?.type).toBe('error');
  });

  it('reports stale without claiming unavailable when the watcher degraded', () => {
    const view = codeIndexPresentation({ status: at({ watcher: { active: true, degraded: true, reason: 'watch overflow' } }), checking: false });
    expect(view.canQuery).toBe(true);
    expect(view.freshness).toBe('stale');
  });

  it('reports unknown when freshness cannot be established', () => {
    expect(indexFreshness(undefined)).toBe('unknown');
    expect(indexFreshness(at({ indexed: false }))).toBe('unknown');
    expect(indexFreshness(base, 'read failed')).toBe('unknown');
    expect(indexFreshness(at({ watcher: { active: false, degraded: false } }))).toBe('unknown');
  });

  it('reports current only when nothing suggests the index is behind', () => {
    expect(indexFreshness(at({ watcher: { active: true, degraded: false } }))).toBe('current');
    expect(indexFreshness(at({ autoSync: false }))).toBe('current');
  });

  it('treats pending changes as stale', () => {
    expect(indexFreshness(at({ pendingChanges: 3 }))).toBe('stale');
  });

  it('marks a full rebuild as unavailable while still exposing freshness', () => {
    const view = codeIndexPresentation({ status: at({ state: 'indexing' }), checking: false });
    expect(view.canQuery).toBe(false);
    expect(view.freshness).toBe('current');
  });

  it('does not invent availability while checking', () => {
    const view = codeIndexPresentation({ checking: true });
    expect(view.canQuery).toBe(false);
    expect(view.freshness).toBe('unknown');
  });
});

describe('watcher pending keeps silent polling alive', () => {
  it('polls while the watcher is starting after the first query', () => {
    expect(codeIndexWatcherPending(at({ watcher: { active: false, degraded: false } }))).toBe(true);
  });

  it('stops once the watcher settled, degraded, or auto sync is off', () => {
    expect(codeIndexWatcherPending(at({ watcher: { active: true, degraded: false } }))).toBe(false);
    expect(codeIndexWatcherPending(at({ watcher: { active: false, degraded: true } }))).toBe(false);
    expect(codeIndexWatcherPending(at({ autoSync: false, watcher: { active: false, degraded: false } }))).toBe(false);
    expect(codeIndexWatcherPending(at({ indexed: false, watcher: { active: false, degraded: false } }))).toBe(false);
    expect(codeIndexWatcherPending(base)).toBe(false);
    expect(codeIndexWatcherPending(undefined)).toBe(false);
  });
});
