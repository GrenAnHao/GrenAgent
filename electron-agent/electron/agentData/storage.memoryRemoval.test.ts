import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDataStorage } from './storage';

describe('retired Memory data migration', () => {
  it('deletes legacy Memory data and pending work while preserving shared data and reclaiming disk space', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-removal-'));
    const path = join(dir, 'agent-data.db');
    const storage = new AgentDataStorage(path);
    try {
      storage.migrate();
      storage.db.exec(`
        UPDATE schema_version SET version=4;
        CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT);
        CREATE TABLE memory_captures (capture_key TEXT PRIMARY KEY, transcript TEXT);
        CREATE TABLE memory_layer_schedules (user_id TEXT, payload TEXT);
        CREATE TABLE wiki_assets (id TEXT PRIMARY KEY, content TEXT);
        CREATE TABLE agent_jobs (id TEXT PRIMARY KEY, kind TEXT);
        CREATE TABLE agent_config (module TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE agent_audit (id TEXT PRIMARY KEY, action TEXT, detail TEXT);
        INSERT INTO memories VALUES ('m', hex(zeroblob(262144)));
        INSERT INTO memory_captures VALUES ('capture', hex(zeroblob(262144)));
        INSERT INTO memory_layer_schedules VALUES ('local', 'pending');
        INSERT INTO wiki_assets VALUES ('wiki', 'keep wiki');
        INSERT INTO agent_jobs VALUES ('memory-job', 'memory_extract'), ('code-job','codegraph.sync');
        INSERT INTO agent_config VALUES ('memory','legacy'), ('codeRetrieval','keep config');
        INSERT INTO plugin_state VALUES ('memory','ready','{}',1), ('code-retrieval','ready','{}',1);
        INSERT INTO agent_audit VALUES ('memory-event','memory.create','{"id":"m"}'),
          ('memory-config','config.update','{"module":"memory"}'),
          ('memory-job','job.create','{"kind":"memory_extract"}'),
          ('memory-resource','job.complete','{"resource":{"type":"memory","id":"m"}}'),
          ('wiki-event','job.create','{"kind":"wiki.sync"}'), ('plain-text','job.create','{"message":"memory is ordinary text"}'),
          ('same-id-wiki','wiki.create','{"id":"memory-job"}');
        INSERT INTO threads VALUES ('thread','project','/repo','keep thread','active',1,1,NULL);
        INSERT INTO permission_rules VALUES ('rule','global','','bash','exact','pwd','allow',1,NULL);
        INSERT INTO tool_audit (id,workspace,origin,tool,args,decision,resolution,created_at)
          VALUES ('audit','/repo','agent','bash','{}','allow','resolved',1);
      `);
      const task = storage.db.prepare('INSERT INTO service_tasks(id,kind,status,input,attempts,created_at,updated_at) VALUES (?, ?, ?, ?, 0, 1, 1)');
      for (const [id, kind, status] of [
        ['extract', 'memory_extract', 'running'], ['dedup', 'memory_deduplicate', 'queued'],
        ['scene', 'memory_scene', 'completed'], ['persona', 'memory_persona', 'failed'],
        ['summarize', 'memory_summarize', 'completed'], ['wiki', 'wiki_page_generate', 'queued'],
        ['similar', 'memoryXextract', 'queued'],
      ]) task.run(id!, kind!, status!, '{}');
      const before = statSync(path).size;

      storage.migrate();
      storage.migrate();

      expect(storage.schemaVersion()).toBe(5);
      expect(storage.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('memories','memory_captures','memory_layer_schedules')").all()).toEqual([]);
      expect(storage.db.prepare('SELECT id FROM service_tasks ORDER BY id').all().map((row) => row.id)).toEqual(['similar', 'wiki']);
      expect(storage.db.prepare('SELECT content FROM wiki_assets').get()?.content).toBe('keep wiki');
      expect(storage.db.prepare('SELECT title FROM threads').get()?.title).toBe('keep thread');
      expect(storage.db.prepare('SELECT id FROM permission_rules').get()?.id).toBe('rule');
      expect(storage.db.prepare('SELECT id FROM tool_audit').get()?.id).toBe('audit');
      expect(storage.db.prepare('SELECT id FROM agent_jobs').all().map((row) => row.id)).toEqual(['code-job']);
      expect(storage.db.prepare('SELECT module FROM agent_config').all().map((row) => row.module)).toEqual(['codeRetrieval']);
      expect(storage.db.prepare('SELECT id FROM plugin_state').all().map((row) => row.id)).toEqual(['code-retrieval']);
      expect(storage.db.prepare('SELECT id FROM agent_audit ORDER BY id').all().map((row) => row.id)).toEqual(['plain-text', 'same-id-wiki', 'wiki-event']);
      expect(statSync(path).size).toBeLessThan(before);
      expect(storage.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
