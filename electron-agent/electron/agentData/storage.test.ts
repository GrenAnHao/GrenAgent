import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDataStorage } from './storage';

describe('AgentDataStorage', () => {
  it('runs migrations idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-data-'));
    const file = join(dir, 'data.db');
    const first = new AgentDataStorage(file); first.migrate(); first.migrate();
    expect(first.schemaVersion()).toBe(4);
    expect(first.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'goal_%'").all()).toHaveLength(0);
    first.close();
    const second = new AgentDataStorage(file); second.migrate();
    expect(second.schemaVersion()).toBe(4);
    expect(second.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'goal_%'").all()).toHaveLength(0);
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('upgrades the schema with app server persistence tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-data-'));
    const file = join(dir, 'data.db');
    const storage = new AgentDataStorage(file);
    storage.migrate();

    expect(storage.schemaVersion()).toBeGreaterThanOrEqual(2);
    const tables = storage.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining([
      'threads', 'turns', 'items', 'app_events', 'service_tasks', 'plugin_state',
      'permission_rules', 'tool_audit',
    ]));
    expect(storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'goal_%'").all()).toHaveLength(0);
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('upgrades a v2 database without dropping legacy rows', () => {
    const storage = new AgentDataStorage(':memory:');
    storage.db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version(version) VALUES (2);
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace TEXT NOT NULL, title TEXT,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE turns (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL, mode TEXT NOT NULL, input TEXT NOT NULL, permission_profile TEXT NOT NULL,
        created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, error TEXT
      );
      INSERT INTO threads(id,project_id,workspace,title,status,created_at,updated_at) VALUES ('legacy-thread','p','/w','old','active',1,2);
      INSERT INTO turns(id,thread_id,status,mode,input,permission_profile,created_at) VALUES ('legacy-turn','legacy-thread','completed','chat','{}','workspace',3);
    `);
    storage.migrate();

    expect(storage.schemaVersion()).toBe(4);
    expect(storage.db.prepare('SELECT id,session_id FROM threads').get()).toMatchObject({ id: 'legacy-thread', session_id: null });
    expect(storage.db.prepare('SELECT id,session_id FROM turns').get()).toMatchObject({ id: 'legacy-turn', session_id: null });
    expect(storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'goal_%'").all()).toHaveLength(0);
    expect(storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('permission_rules','tool_audit')").all()).toHaveLength(2);
    storage.close();
  });
});
