import { AgentDataStorage } from './storage';
import { JobStore } from './jobStore';

export function taskFixture() {
  const storage = new AgentDataStorage(':memory:'); storage.migrate();
  const db = storage.db; const jobs = new JobStore(db);
  db.exec(`CREATE TABLE wiki_task_targets (task_source TEXT,task_id TEXT,kb_id TEXT,source_id TEXT,page_id TEXT,active INTEGER,can_cancel INTEGER);`);
  const system = (id: string, status = 'queued', updatedAt = 10, input: unknown = {}, workspace = '/repo') => {
    db.prepare('INSERT INTO service_tasks(id,kind,source_project_id,status,input,output,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, 'wiki_page_generate', workspace, status, JSON.stringify(input), JSON.stringify({ source: 'PRIVATE OUTPUT', generated: 1 }), 2, 1, updatedAt);
  };
  return { db, jobs, system, cleanup: () => storage.close() };
}
