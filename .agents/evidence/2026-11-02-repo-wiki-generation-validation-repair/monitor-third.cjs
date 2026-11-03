const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const parent = '10f59f63-e763-4379-9970-f77428f63d6b';
const since = Date.now();
let taskId, last = '';
async function main() {
  while (Date.now() - since < 35 * 60000) {
    const db = new DatabaseSync(path.join(process.env.APPDATA, 'electron-agent', 'agent-data.db'), { readOnly: true });
    let row, bad;
    try {
      if (!taskId) {
        row = db.prepare("SELECT id FROM agent_jobs WHERE json_extract(metadata,'$.retryOf')=? AND json_extract(metadata,'$.repoWiki.intent')='repair' AND created_at>=? ORDER BY created_at DESC LIMIT 1").get(parent, since);
        taskId = row?.id;
      }
      if (taskId) {
        row = db.prepare('SELECT state,metadata FROM agent_jobs WHERE id=?').get(taskId);
        bad = db.prepare("SELECT item_id,state,error FROM knowledge_build_items WHERE task_id=? AND state IN ('failed','blocked') ORDER BY updated_at DESC LIMIT 1").get(taskId);
      }
    } finally { db.close(); }
    if (row?.metadata) {
      const m = JSON.parse(row.metadata).repoWiki;
      const snapshot = { taskId, state: row.state, phase: m.phase, item: m.currentItem, counts: m.counts, error: m.error };
      const key = JSON.stringify(snapshot);
      if (key !== last) {
        last = key;
        const line = JSON.stringify({ time: new Date().toISOString(), ...snapshot });
        fs.appendFileSync(path.join(__dirname, 'live-third-repair-events.jsonl'), line + '\n');
        console.log(line);
      }
      if (row.state === 'completed') return;
      if (bad || ['failed','blocked','cancelled','paused'].includes(row.state)) {
        console.log('STOP_OR_ATTENTION ' + JSON.stringify(bad ?? {}));
        process.exitCode = 2;
        return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  console.log('MONITOR_DEADLINE');
  process.exitCode = 3;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
