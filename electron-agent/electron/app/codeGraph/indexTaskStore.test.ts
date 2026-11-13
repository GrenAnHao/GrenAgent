import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexTaskStore } from './indexTaskStore';

let dir: string;
let store: IndexTaskStore;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'index-tasks-')); store = new IndexTaskStore(join(dir, 'index-tasks.sqlite')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('index task store', () => {
  it('runs a task from pending to completed with stage counts', () => {
    const task = store.create({ id: 't1', workspace: 'D:/repo' });
    expect(task.state).toBe('pending');
    store.start('t1');
    store.stage('t1', '扫描文件', { processed: 30, total: 120 });
    const running = store.get('t1')!;
    expect(running.progress).toBe(25);
    expect(running.stage).toBe('扫描文件');
    expect(store.complete('t1')!.state).toBe('completed');
    expect(store.get('t1')!.progress).toBe(100);
  });

  it('rejects contradictory stage counts and empty stages', () => {
    store.create({ id: 't1', workspace: 'D:/repo' });
    store.start('t1');
    expect(() => store.stage('t1', '解析', { processed: 5, total: 2 })).toThrow('INVALID_COUNTS');
    expect(() => store.stage('t1', '   ')).toThrow('INVALID_STAGE');
  });

  it('does not move progress once a task settled', () => {
    store.create({ id: 't1', workspace: 'D:/repo' });
    store.start('t1');
    store.fail('t1', 'boom');
    store.stage('t1', '扫描文件', { processed: 1, total: 2 });
    expect(store.get('t1')!.state).toBe('failed');
    expect(store.get('t1')!.stage).toBeUndefined();
  });

  it('handles cancel and protects active tasks from removal', () => {
    store.create({ id: 't1', workspace: 'D:/repo' });
    store.start('t1');
    expect(() => store.remove('t1')).toThrow('TASK_ACTIVE');
    store.cancel('t1');
    expect(store.remove('t1')).toEqual({ deleted: true });
  });

  it('reports an active task per workspace so a second sync is not double-dispatched', () => {
    store.create({ id: 't1', workspace: 'D:/repo' });
    store.start('t1');
    expect(store.activeFor('D:/repo')?.id).toBe('t1');
    expect(store.activeFor('D:/other')).toBeUndefined();
    store.complete('t1');
    expect(store.activeFor('D:/repo')).toBeUndefined();
  });

  it('settles interrupted runs on startup without claiming a rollback', () => {
    store.create({ id: 't1', workspace: 'D:/repo' });
    store.start('t1');
    store.stage('t1', '关联符号', { processed: 50, total: 100 });
    expect(store.settleOrphans()).toBe(1);
    const task = store.get('t1')!;
    expect(task.state).toBe('failed');
    expect(task.error).toMatch(/JOB_INTERRUPTED/);
    expect(task.stage).toBe('关联符号');
    expect(task.progress).toBe(50);
  });

  it('does not resurrect completed tasks on startup', () => {
    store.create({ id: 't1', workspace: 'D:/repo' });
    store.start('t1');
    store.complete('t1');
    expect(store.settleOrphans()).toBe(0);
  });

  it('keeps one breaker record per workspace instead of piling up rows', () => {
    const first = store.recordBreaker('D:/repo', 'first failure');
    const again = store.recordBreaker('D:/repo', 'second failure');
    expect(again.id).toBe(first.id);
    expect(store.list({ workspace: 'D:/repo' })).toHaveLength(1);
    expect(store.get(first.id)!.error).toBe('second failure');
    expect(store.get(first.id)!.origin).toBe('breaker');
  });

  it('does not create a breaker row while a real sync is running', () => {
    store.create({ id: 't1', workspace: 'D:/repo' });
    store.start('t1');
    expect(store.recordBreaker('D:/repo', 'failed').id).toBe('t1');
  });

  it('survives a reopen so index history is not lost on restart', () => {
    store.create({ id: 't1', workspace: 'D:/repo' });
    store.start('t1');
    store.stage('t1', '扫描文件', { processed: 1, total: 4 });
    store.close();
    store = new IndexTaskStore(join(dir, 'index-tasks.sqlite'));
    expect(store.get('t1')!.stage).toBe('扫描文件');
  });

  it('maps an unknown persisted state to failed rather than inventing one', () => {
    store.db.prepare("INSERT INTO index_tasks(id,workspace,kind,state,progress,created_at,updated_at) VALUES('x','D:/r','codegraph.sync','nonsense',0,1,2)").run();
    expect(store.get('x')!.state).toBe('failed');
  });
});
