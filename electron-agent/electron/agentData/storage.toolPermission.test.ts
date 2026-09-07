import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDataStorage } from './storage';

const directories: string[] = [];
const stores: AgentDataStorage[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<AgentDataStorage> {
  const directory = await mkdtemp(join(tmpdir(), 'tool-permission-schema-'));
  directories.push(directory);
  const store = new AgentDataStorage(join(directory, 'agent-data.db'));
  stores.push(store);
  store.migrate();
  return store;
}

function columns(store: AgentDataStorage, table: string): string[] {
  return (store.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

describe('tool permission schema', () => {
  it('creates permission_rules with the documented columns', async () => {
    const store = await fixture();
    expect(columns(store, 'permission_rules')).toEqual([
      'id', 'scope', 'scope_key', 'tool', 'matcher_kind', 'matcher', 'effect', 'created_at', 'expires_at',
    ]);
  });

  it('creates tool_audit with the documented columns', async () => {
    const store = await fixture();
    expect(columns(store, 'tool_audit')).toEqual([
      'id', 'workspace', 'session_id', 'thread_id', 'turn_id', 'tool_call_id', 'origin', 'tool',
      'args', 'decision', 'resolution', 'rule_id', 'queue_payload', 'created_at', 'resolved_at',
    ]);
  });

  it('bumps the schema version to 4', async () => {
    const store = await fixture();
    expect(store.schemaVersion()).toBe(4);
  });

  it('is idempotent across repeated migrations', async () => {
    const store = await fixture();
    store.migrate();
    expect(store.schemaVersion()).toBe(4);
    expect(columns(store, 'permission_rules')).toContain('effect');
  });
});
