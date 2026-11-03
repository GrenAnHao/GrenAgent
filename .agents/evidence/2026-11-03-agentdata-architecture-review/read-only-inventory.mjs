import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

// Assessment only: no application classes, migrations, model calls, or writes to application data.
const root = join(process.env.APPDATA, 'electron-agent');
const report = { observedAt: new Date().toISOString(), root, files: [], databases: [], processes: [], diagnostics: {} };
const sqlSummary = (file) => {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    const result = { path: file, bytes: statSync(file).size, journalMode: db.prepare('PRAGMA journal_mode').get(), tables, counts: {}, groups: {} };
    const allowed = ['schema_version','agent_jobs','service_tasks','agent_audit','audit_events','threads','turns','items','app_events','tool_audit','permission_rules','plugin_state','knowledge_runs','knowledge_build_items','knowledge_model_requests','agent_job_leases','native_wiki_projection','native_wiki_events','operations','runs','pages','publications','publication_journals'];
    for (const name of allowed.filter(n => tables.includes(n))) {
      try { result.counts[name] = db.prepare(`SELECT count(*) AS count FROM "${name}"`).get().count; } catch(e) { result.counts[name] = { error: e.code ?? e.name }; }
    }
    if(tables.includes('schema_version')) result.schema = db.prepare('SELECT * FROM schema_version LIMIT 3').all();
    if(tables.includes('agent_jobs')) result.groups.jobs = db.prepare('SELECT kind,state,count(*) AS count FROM agent_jobs GROUP BY kind,state ORDER BY kind,state').all();
    if(tables.includes('service_tasks')) result.groups.serviceTasks = db.prepare('SELECT kind,status,count(*) AS count FROM service_tasks GROUP BY kind,status ORDER BY kind,status').all();
    if(tables.includes('operations')) result.groups.operations = db.prepare('SELECT state,count(*) AS count FROM operations GROUP BY state').all();
    return result;
  } catch(e) { return { path:file, error:e.code ?? e.name, message: e.message }; }
  finally { db?.close(); }
};
// Bounded discovery of database names only; never inspect raw documents, prompts, credentials, or transcript payloads.
function walk(dir, depth = 0) {
  if(depth > 4 || !existsSync(dir)) return;
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
    const file = join(dir,entry.name);
    if(entry.isDirectory() && !['Cache','Code Cache','GPUCache','DawnCache','Session Storage','Local Storage'].includes(entry.name)) walk(file,depth+1);
    else if(entry.isFile() && /(?:\.db|\.sqlite)(?:-wal|-shm)?$/.test(entry.name)) {
      report.files.push({path:file,bytes:statSync(file).size});
      if(/(?:agent-data\.db|wiki\.sqlite)$/.test(entry.name)) report.databases.push(sqlSummary(file));
    }
  }
}
walk(root);
try {
  const ps = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(electron|node|grenagent)\\.exe$' } | ForEach-Object { $role='other'; if ($_.CommandLine -match '(agentdata-host|codegraph-host|knowledge-host|repo-wiki-host|agent-host|wiki-host)') { $role=$Matches[1] } elseif ($_.CommandLine -match 'electron-agent') { $role='electron-agent' }; [pscustomobject]@{name=$_.Name;pid=$_.ProcessId;parentPid=$_.ParentProcessId;role=$role;rssBytes=$_.WorkingSetSize} } | ConvertTo-Json -Compress";
  report.processes = (JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{encoding:'utf8',timeout:15000}) || '[]')).filter(process => process.role !== 'other');
} catch(e) { report.processError = e.code ?? e.message; }
const diagFile=join(root,'logs','runtime-diag.jsonl');
if(existsSync(diagFile)) {
  const info=statSync(diagFile), fd=openSync(diagFile,'r');
  try {
    const length=Math.min(2*1024*1024,info.size), data=Buffer.alloc(length);
    readSync(fd,data,0,length,info.size-length);
    const lines=data.toString('utf8').split('\n').slice(info.size>length?1:0).filter(Boolean);
    const rows=lines.flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}});
    const kinds={}; for(const row of rows) kinds[row.kind??'unknown']=(kinds[row.kind??'unknown']??0)+1;
    const samples=rows.filter(r=>['agentdata-host-sample','codegraph-host-sample'].includes(r.kind));
    report.diagnostics={path:diagFile,bytes:info.size,modifiedAt:info.mtime.toISOString(),tailRows:rows.length,kinds,sampleFieldNames:samples.length?Object.keys(samples.at(-1)):[],latestSamples:samples.slice(-4)};
  } finally { closeSync(fd); }
}
console.log(JSON.stringify(report,null,2));
