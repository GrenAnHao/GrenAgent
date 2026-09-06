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
    expect(first.schemaVersion()).toBe(3);
    first.close();
    const second = new AgentDataStorage(file); second.migrate();
    expect(second.schemaVersion()).toBe(3); second.close();
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
      'threads', 'turns', 'items', 'service_tasks', 'plugin_state',
    ]));
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
