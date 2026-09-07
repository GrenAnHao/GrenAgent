import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pageFixture } from './wikiTestFixture';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() { const value = pageFixture(); cleanups.push(value.cleanup); return value; }

describe('Wiki lifecycle deletion gates', () => {
  it('does not delete a different page which now occupies a moved page’s stale index path', () => {
    const { libraries, library, pages, files } = fixture();
    const original = pages.createManual(library.kbId, { title: 'A', content: 'A body', sourceRefs: [] });
    const moved = original.path.replace(/\.md$/, '-moved.md'); renameSync(original.path, moved);
    writeFileSync(original.path, files.renderAt({ ...original, pageId: 'other-page', title: 'B', content: 'B body' }));
    expect(pages.listByLibrary(library.kbId)).toHaveLength(2);
    const target = { kind: 'page' as const, kbId: library.kbId, pageId: original.pageId };
    libraries.beginDelete(target); expect(libraries.finishDelete(target)).toEqual({ state: 'deleted' });
    expect(existsSync(moved)).toBe(false); expect(existsSync(original.path)).toBe(true);
    expect(pages.readById(library.kbId, 'other-page')?.content).toBe('B body');
  });

  it('keeps deleting until the actual writer settles and rejects late publication', () => {
    const { pages, sources, libraries, library, files } = fixture();
    const source = sources.createText(library.kbId, { kind: 'manual', name: 'a.md', content: 'source' });
    const permit = libraries.acquirePermit(library.kbId, source.sourceId);
    libraries.recordTask({ taskSource: 'agent_job', taskId: 'job', kbId: library.kbId, sourceId: source.sourceId, pageId: source.generatedPageId, active: true, canCancel: true });
    const target = { kind: 'library' as const, kbId: library.kbId };
    libraries.beginDelete(target); const epoch = libraries.get(library.kbId)!.epoch; libraries.beginDelete(target);
    expect(libraries.get(library.kbId)?.epoch).toBe(epoch);
    expect(libraries.finishDelete(target).state).toBe('waiting');
    expect(pages.publishGenerated(permit, { title: 'Late', content: 'late' })).toEqual({ state: 'skipped', reason: 'deleted' });
    expect(() => libraries.recordTask({ taskSource: 'agent_job', taskId: 'new', kbId: library.kbId, active: true, canCancel: true })).toThrow(/active/i);
    libraries.settleTask('agent_job', 'job');
    expect(libraries.finishDelete(target)).toEqual({ state: 'deleted' });
    expect(libraries.get(library.kbId)).toMatchObject({ lifecycle: 'deleted', bindings: [] });
    expect(existsSync(files.filePathAt(library, 'library.json'))).toBe(true);
  });
  it('keeps deleted source snapshots readable from surviving page references', () => {
    const { pages, sources, libraries, library } = fixture();
    const source = sources.createText(library.kbId, { kind: 'manual', name: 'a.md', content: 'source' });
    const ref = { sourceId: source.sourceId, revision: source.revision };
    const page = pages.createManual(library.kbId, { title: 'Retained', content: '# Retained', sourceRefs: [ref] });
    const target = { kind: 'source' as const, kbId: library.kbId, sourceId: source.sourceId };
    libraries.beginDelete(target); libraries.finishDelete(target);
    expect(sources.list(library.kbId)).toEqual([]);
    expect(sources.readSnapshot(library.kbId, ref)).toBe('source');
    expect(pages.readById(library.kbId, page.pageId)?.sourceRefs).toEqual([ref]);
  });
  it('persists page tombstones and suppression and blocks restored external copies', () => {
    const { pages, sources, libraries, library } = fixture();
    const source = sources.createText(library.kbId, { kind: 'manual', name: 'a.md', content: 'source' });
    pages.publishGenerated(libraries.acquirePermit(library.kbId, source.sourceId), { title: 'Auto', content: 'auto' });
    const page = pages.readById(library.kbId, source.generatedPageId)!; const copy = readFileSync(page.path, 'utf8');
    const target = { kind: 'page' as const, kbId: library.kbId, pageId: page.pageId };
    libraries.beginDelete(target); libraries.finishDelete(target);
    expect(sources.get(library.kbId, source.sourceId)?.generationSuppressed).toBe(true);
    expect(pages.readById(library.kbId, page.pageId)).toBeUndefined();
    writeFileSync(page.path, copy);
    expect(pages.reindexLibrary(library.kbId)).toMatchObject({ pages: 0, diagnostics: [{ code: 'PAGE_DELETED' }] });
    expect(libraries.pageDeleted(library.kbId, page.pageId)).toBe(true);
  });
  it('only recovers leases from persisted actual terminal jobs at startup', () => {
    const { db, libraries, library } = fixture();
    db.exec('CREATE TABLE agent_jobs (id TEXT PRIMARY KEY,state TEXT)');
    db.prepare('INSERT INTO agent_jobs(id,state) VALUES(?,?)').run('job', 'running');
    libraries.recordTask({ taskSource: 'agent_job', taskId: 'job', kbId: library.kbId, active: true, canCancel: true });
    libraries.recoverTasks(); expect(libraries.activeTasks({ kind: 'library', kbId: library.kbId })).toHaveLength(1);
    db.prepare('UPDATE agent_jobs SET state=? WHERE id=?').run('failed', 'job');
    expect(libraries.activeTasks({ kind: 'library', kbId: library.kbId })).toHaveLength(1);
    libraries.recoverTasks(); expect(libraries.activeTasks({ kind: 'library', kbId: library.kbId })).toEqual([]);
  });
  it('treats whole-library writer leases as covering every source and page', () => {
    const { libraries, library } = fixture();
    libraries.recordTask({ taskSource: 'service_task', taskId: 'legacy', kbId: library.kbId, active: true, canCancel: false });
    expect(libraries.activeTasks({ kind: 'source', kbId: library.kbId, sourceId: 'any-source' })).toHaveLength(1);
    expect(libraries.activeTasks({ kind: 'page', kbId: library.kbId, pageId: 'any-page' })).toHaveLength(1);
  });
  it('clears unqueued orphan service leases during recovery but retains queued writers', () => {
    const { libraries, library, db } = fixture();
    db.exec('CREATE TABLE service_tasks (id TEXT PRIMARY KEY,status TEXT)');
    db.prepare('INSERT INTO service_tasks(id,status) VALUES(?,?)').run('queued', 'queued');
    for (const taskId of ['missing', 'queued']) libraries.recordTask({ taskSource: 'service_task', taskId, kbId: library.kbId, active: true, canCancel: false });
    libraries.recoverTasks();
    expect(libraries.activeTasks({ kind: 'library', kbId: library.kbId }).map((target) => target.taskId)).toEqual(['queued']);
  });
  it('deletes the actual moved generated file and preserves source suppression', () => {
    const { libraries, library, pages, sources } = fixture();
    const source = sources.createText(library.kbId, { kind: 'manual', name: 'a.md', content: 'source' });
    pages.publishGenerated(libraries.acquirePermit(library.kbId, source.sourceId), { title: 'Auto', content: 'auto' });
    const page = pages.readById(library.kbId, source.generatedPageId)!; const moved = page.path.replace(/\.md$/, '-moved.md');
    renameSync(page.path, moved);
    libraries.beginDelete({ kind: 'page', kbId: library.kbId, pageId: page.pageId });
    libraries.finishDelete({ kind: 'page', kbId: library.kbId, pageId: page.pageId });
    expect(existsSync(moved)).toBe(false);
    expect(sources.get(library.kbId, source.sourceId)?.generationSuppressed).toBe(true);
  });
});
