import {DatabaseSync} from '../_shared/sqlite.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sharedOriginRegistry, type UsageOriginRegistry } from './originRegistry.js';

/** Freeze before a managed operation can create any new targets. Never refresh this file. */
export function ensureLegacyRoster(agentDir:string, registry:UsageOriginRegistry=sharedOriginRegistry(agentDir)):UsageOriginRegistry {
  const directory=join(agentDir,'usage');const file=join(directory,'legacy-roster-v1.json');
  mkdirSync(directory,{recursive:true});
  const anchor=new DatabaseSync(join(directory,'ledger.db'));
  anchor.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  anchor.exec('BEGIN IMMEDIATE');
  try{
  const migrated=anchor.prepare("SELECT value FROM meta WHERE key='legacy_roster_version'").get() as {value:string}|undefined;
  if(migrated&&migrated.value!=='1')throw new Error('Usage legacy roster version is unavailable');
  if(!existsSync(file)&&migrated)throw new Error('Usage legacy roster is missing; historical reconciliation is unavailable');
  if(!existsSync(file)) {
    const sessions:Array<{sessionId:string;path:string}>=[];
    const visit=(dir:string):void=>{
      if(!existsSync(dir))return;
      for(const item of readdirSync(dir,{withFileTypes:true})) {
        const path=join(dir,item.name);if(item.isDirectory())visit(path);
        else if(item.isFile()&&path.endsWith('.jsonl')) {
          const content=readFileSync(path,'utf8');
          const first=content.split('\n',1)[0];let header;try{header=JSON.parse(first);}catch{continue;}
          if(header?.type==='session'&&typeof header.id==='string'&&!content.includes('"usage_origin_required"'))sessions.push({sessionId:header.id,path:resolve(path)});
        }
      }
    };
    visit(join(agentDir,'sessions'));mkdirSync(directory,{recursive:true});
    try {writeFileSync(file,JSON.stringify({version:1,sessions}),{flag:'wx'});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  }
  let roster:{version:number;sessions:Array<{sessionId:string;path:string}>};
  try {roster=JSON.parse(readFileSync(file,'utf8'));if(roster.version!==1||!Array.isArray(roster.sessions)||roster.sessions.some(s=>typeof s.sessionId!=='string'||typeof s.path!=='string'))throw new Error();}
  catch {throw new Error('Usage legacy roster is corrupt; historical reconciliation is unavailable');}
  registry.freezeLegacyRoster(roster.sessions);
  anchor.prepare("INSERT OR REPLACE INTO meta VALUES('legacy_roster_version','1')").run();
  anchor.exec('COMMIT');return registry;
  }catch(error){anchor.exec('ROLLBACK');throw error;}finally{anchor.close();}
}
