import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentDataStorage } from '../../../electron-agent/electron/agentData/storage.ts';

// Run only after the old application has exited. No memory payload is printed or copied.
const root = resolve(process.argv[2] ?? '');
assert.equal(root, resolve('C:/Users/rxstudio/AppData/Roaming/electron-agent'));
const path = join(root, 'agent-data.db');
const retired = new Set(['memories', 'memory_captures', 'memory_layer_schedules']);
function snapshot() {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    const counts = Object.fromEntries(tables.map(({ name }) => [name, Number(db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get()!.n)]));
    const memoryTasks = Number(db.prepare("SELECT count(*) AS n FROM service_tasks WHERE kind GLOB 'memory_*'").get()!.n);
    const memoryPlugin = Number(db.prepare("SELECT count(*) AS n FROM plugin_state WHERE id='memory'").get()!.n);
    const memoryConfig = Number(db.prepare("SELECT count(*) AS n FROM agent_config WHERE module='memory'").get()!.n);
    return { bytes: statSync(path).size, counts, memoryTasks, memoryPlugin, memoryConfig, integrity: String(db.prepare('PRAGMA integrity_check').get()!.integrity_check) };
  } finally { db.close(); }
}
const before = snapshot();
const storage = new AgentDataStorage(path);
try { storage.migrate(); } finally { storage.close(); }
const after = snapshot();
assert.equal(after.memoryTasks, 0);
assert.equal(after.memoryPlugin, 0);
assert.equal(after.memoryConfig, 0);
for (const [name, count] of Object.entries(before.counts)) {
  if (retired.has(name)) { assert.equal(name in after.counts, false); continue; }
  const removed = name === 'service_tasks' ? before.memoryTasks : name === 'plugin_state' ? before.memoryPlugin : name === 'agent_config' ? before.memoryConfig : 0;
  assert.equal(after.counts[name], count - removed, `unrelated table changed: ${name}`);
}
assert.equal(after.integrity, 'ok');
const settingsRemoved: Record<string, string[]> = {};
for (const name of ['settings.json', 'runtime-settings.json', 'app-state.json']) {
  const file = join(root, name);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  const settings = name === 'app-state.json' ? value.settings : value;
  if (!settings || typeof settings !== 'object') continue;
  const keys = Object.keys(settings).filter((key) => key.startsWith('MEMORY_'));
  for (const key of keys) delete settings[key];
  if (keys.length) writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  settingsRemoved[name] = keys;
}
const initial = JSON.parse(readFileSync(new URL('./local-initial-inspection.json', import.meta.url), 'utf8'));
for (const [name, count] of Object.entries(initial.counts)) {
  if (retired.has(name)) { assert.equal(name in after.counts, false); continue; }
  const removed = name === 'service_tasks' ? initial.memoryTasks : name === 'plugin_state' ? 1 : 0;
  assert.equal(after.counts[name], Number(count) - removed, `initial non-Memory data changed: ${name}`);
}
const result = { path, initialBytes: initial.bytes, before, after, reclaimedBytes: initial.bytes - after.bytes, repeatedMigrationReclaimedBytes: before.bytes - after.bytes, settingsRemoved };
writeFileSync(new URL('./local-cleanup.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
