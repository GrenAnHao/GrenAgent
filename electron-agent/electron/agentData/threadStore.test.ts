import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDataStorage } from './storage';
import { ThreadStore } from './threadStore';

function withStore<T>(fn: (store: ThreadStore, file: string, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'thread-store-'));
  const file = join(dir, 'data.db');
  const storage = new AgentDataStorage(file);
  storage.migrate();
  try { return fn(new ThreadStore(storage), file, dir); }
  finally { storage.close(); rmSync(dir, { recursive: true, force: true }); }
}

describe('ThreadStore', () => {
  it('creates and reads a thread with its turns and items', () => withStore((store) => {
    const thread = store.createThread({ id: 'thread-1', projectId: 'project-1', workspace: '/work', title: 'Test' });
    const turn = store.createTurn({ id: 'turn-1', threadId: thread.id, input: 'hello', permissionProfile: 'readonly' });
    store.upsertItem({ id: 'item-1', threadId: thread.id, turnId: turn.id, type: 'user_message', status: 'completed', payload: { text: 'hello' } });

    expect(store.listThreads()).toEqual([expect.objectContaining({ id: 'thread-1', status: 'active' })]);
    expect(store.readThread(thread.id)).toEqual({
      thread: expect.objectContaining({ id: 'thread-1' }),
      turns: [expect.objectContaining({ id: 'turn-1', status: 'queued' })],
      items: [expect.objectContaining({ id: 'item-1', payload: { text: 'hello' } })],
    });
  }));

  it('persists failed turn errors across reopening the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-store-reopen-'));
    const file = join(dir, 'data.db');
    const firstStorage = new AgentDataStorage(file); firstStorage.migrate();
    const firstStore = new ThreadStore(firstStorage);
    firstStore.createThread({ id: 'thread-1', projectId: 'project-1', workspace: '/work' });
    firstStore.createTurn({ id: 'turn-1', threadId: 'thread-1', input: 'hello', permissionProfile: '{}' });
    firstStore.updateTurn('turn-1', { status: 'failed', error: 'boom' });
    firstStorage.close();

    const secondStorage = new AgentDataStorage(file); secondStorage.migrate();
    expect(new ThreadStore(secondStorage).readThread('thread-1')).toEqual(expect.objectContaining({
      turns: [expect.objectContaining({ status: 'failed', error: 'boom' })],
    }));
    secondStorage.close(); rmSync(dir, { recursive: true, force: true });
  });

});
