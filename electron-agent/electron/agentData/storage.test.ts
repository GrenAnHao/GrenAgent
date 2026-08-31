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
    expect(first.schemaVersion()).toBe(1);
    first.close();
    const second = new AgentDataStorage(file); second.migrate();
    expect(second.schemaVersion()).toBe(1); second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
