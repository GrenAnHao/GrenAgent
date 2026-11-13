import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from '../_shared/sqlite.js';

export interface UsageEntryRef { sessionId: string; entryId: string }
export type UsageOrigin = { kind: 'local-origin'; originSessionId: string; originEntryId: string } | { kind: 'external-history' } | { kind: 'unverified' };
export interface OriginOperation {
  operationId: string;
  kind: 'fork' | 'clone' | 'import';
  targetSessionId: string;
  mappings: Array<{ targetEntryId: string; source?: UsageEntryRef }>;
}
/** Host-only port. File/renderer origin declarations never enter this API. */
export class UsageOriginRegistry {
  private db: DatabaseSync;
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try{
    this.db.exec('BEGIN IMMEDIATE');
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_paths(session_id TEXT PRIMARY KEY,path TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS origin_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_sessions(path TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(path,session_id));
      CREATE TABLE IF NOT EXISTS origins(session_id TEXT NOT NULL,entry_id TEXT NOT NULL,kind TEXT NOT NULL,origin_session TEXT,origin_entry TEXT,PRIMARY KEY(session_id,entry_id));
      CREATE TABLE IF NOT EXISTS bindings(origin_session TEXT NOT NULL,origin_entry TEXT NOT NULL,ledger_key TEXT NOT NULL UNIQUE,PRIMARY KEY(origin_session,origin_entry));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL);`);
    const columns=this.db.prepare('PRAGMA table_info(origins)').all() as Array<{name:string}>;
    for(const column of ['source_session','source_entry'])if(!columns.some(c=>c.name===column))this.db.exec(`ALTER TABLE origins ADD COLUMN ${column} TEXT`);
    this.db.exec('COMMIT');
    }catch(error){try{this.db.exec('ROLLBACK');}catch{/* BEGIN may itself fail on a corrupt file. */}this.db.close();throw error;}
  }
  close(): void { this.db.close();if(registries.get(this.file)===this)registries.delete(this.file); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  freezeLegacyRoster(sessions: Array<{ sessionId: string; path: string }>): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM origin_meta WHERE key='legacy_version'").get() as { value: string } | undefined;
      if (row) { if (row.value !== '1') throw new Error('Usage legacy roster is unavailable'); return; }
      for (const session of sessions) this.db.prepare('INSERT OR IGNORE INTO legacy_sessions VALUES(?,?)').run(resolve(session.path), session.sessionId);
      this.db.prepare("INSERT INTO origin_meta VALUES('legacy_version','1')").run();
    });
  }
  isLegacySession(input: { sessionId: string; path: string; required?: boolean }): boolean {
    if (input.required) return false;
    const version = this.db.prepare("SELECT value FROM origin_meta WHERE key='legacy_version'").get() as {value: string} | undefined;
    if (version?.value !== '1') throw new Error('Usage legacy roster is unavailable');
    return !!this.db.prepare('SELECT 1 FROM legacy_sessions WHERE path=? AND session_id=?').get(resolve(input.path), input.sessionId);
  }
  resolveUsageOrigin(ref: UsageEntryRef): UsageOrigin { return this.resolveOrigin(ref,new Set()); }
  private resolveOrigin(ref:UsageEntryRef,seen:Set<string>):UsageOrigin {
    const key=JSON.stringify([ref.sessionId,ref.entryId]);if(seen.has(key))return {kind:'unverified'};seen.add(key);
    const row=this.db.prepare('SELECT kind,origin_session,origin_entry,source_session,source_entry FROM origins WHERE session_id=? AND entry_id=?').get(ref.sessionId,ref.entryId) as {kind:string;origin_session:string;origin_entry:string;source_session:string|null;source_entry:string|null}|undefined;
    if(row?.kind==='local-origin')return {kind:'local-origin',originSessionId:row.origin_session,originEntryId:row.origin_entry};
    if(row?.kind==='external-history')return {kind:'external-history'};
    if(row?.source_session&&row.source_entry){
      const source=this.resolveOrigin({sessionId:row.source_session,entryId:row.source_entry},seen);
      if(source.kind!=='unverified'){
        this.db.prepare("UPDATE origins SET kind=?,origin_session=?,origin_entry=? WHERE session_id=? AND entry_id=? AND kind='unverified'").run(source.kind,source.kind==='local-origin'?source.originSessionId:null,source.kind==='local-origin'?source.originEntryId:null,ref.sessionId,ref.entryId);
        return source;
      }
    }
    return {kind:'unverified'};
  }
  /** Called only for an entry actually appended by a locally executing SDK request. */
  ownsSessionPath(sessionId:string,path:string):boolean {const row=this.db.prepare('SELECT path FROM session_paths WHERE session_id=?').get(sessionId) as {path:string}|undefined;return row?.path===resolve(path);}
  registerLocalEntry(ref: UsageEntryRef,sessionPath?:string|null): void {
    if(sessionPath){
      const path=resolve(sessionPath);const existing=this.db.prepare('SELECT path FROM session_paths WHERE session_id=?').get(ref.sessionId) as {path:string}|undefined;
      if(existing&&existing.path!==path)throw new Error('Usage session path is not the registered local source');
      this.db.prepare('INSERT OR IGNORE INTO session_paths VALUES(?,?)').run(ref.sessionId,path);
    }
    const existing=this.resolveUsageOrigin(ref);
    if (existing.kind !== 'unverified') {
      if (existing.kind !== 'local-origin' || existing.originSessionId !== ref.sessionId || existing.originEntryId !== ref.entryId) throw new Error('Usage origin already assigned');
      return;
    }
    this.db.prepare("INSERT INTO origins(session_id,entry_id,kind,origin_session,origin_entry) VALUES(?,?,'local-origin',?,?)").run(ref.sessionId,ref.entryId,ref.sessionId,ref.entryId);
  }
  bindLedgerKey(ref: UsageEntryRef, key: string): void {
    const origin=this.resolveUsageOrigin(ref);
    if(origin.kind!=='local-origin') throw new Error('Usage origin is unverified');
    const existing=this.ledgerKey(ref);
    if(existing && existing!==key) throw new Error('Canonical usage key is immutable');
    this.db.prepare('INSERT OR IGNORE INTO bindings VALUES(?,?,?)').run(origin.originSessionId,origin.originEntryId,key);
    if(this.ledgerKey(ref)!==key) throw new Error('Canonical usage key belongs to another origin');
  }
  ledgerKey(ref: UsageEntryRef): string | null {
    const o=this.resolveUsageOrigin(ref); if(o.kind!=='local-origin') return null;
    const row=this.db.prepare('SELECT ledger_key FROM bindings WHERE origin_session=? AND origin_entry=?').get(o.originSessionId,o.originEntryId) as {ledger_key:string}|undefined;
    return row?.ledger_key ?? null;
  }
  prepare(operation: OriginOperation): {operationId:string} {
    this.transaction(()=>{
      const targets=new Set<string>();
      const mappings=operation.mappings.map(m=>{
        if(targets.has(m.targetEntryId)) throw new Error('Duplicate usage target entry'); targets.add(m.targetEntryId);
        if(this.resolveUsageOrigin({sessionId:operation.targetSessionId,entryId:m.targetEntryId}).kind!=='unverified') throw new Error('Usage target already assigned');
        const origin:UsageOrigin=operation.kind==='import'?{kind:'external-history'}:m.source?this.resolveUsageOrigin(m.source):{kind:'unverified'};
        return {targetEntryId:m.targetEntryId,origin,...(operation.kind!=='import'&&m.source?{source:m.source}:{})};
      });
      this.db.prepare("INSERT INTO operations VALUES(?,?,'prepared')").run(operation.operationId,JSON.stringify({targetSessionId:operation.targetSessionId,mappings}));
    });
    return {operationId:operation.operationId};
  }
  commit(operationId:string):void {
    this.transaction(()=>{
      const row=this.db.prepare('SELECT payload,state FROM operations WHERE id=?').get(operationId) as {payload:string;state:string}|undefined;
      if(row?.state==='committed')return;
      if(row?.state!=='prepared')throw new Error('Usage operation is not prepared');
      const op=JSON.parse(row.payload) as {targetSessionId:string;mappings:Array<{targetEntryId:string;origin:UsageOrigin;source?:UsageEntryRef}>};
      for(const m of op.mappings) {
        const o=m.origin;
        this.db.prepare('INSERT INTO origins(session_id,entry_id,kind,origin_session,origin_entry) VALUES(?,?,?,?,?)').run(op.targetSessionId,m.targetEntryId,o.kind,o.kind==='local-origin'?o.originSessionId:null,o.kind==='local-origin'?o.originEntryId:null);
        if(o.kind==='unverified'&&m.source)this.db.prepare('UPDATE origins SET source_session=?,source_entry=? WHERE session_id=? AND entry_id=?').run(m.source.sessionId,m.source.entryId,op.targetSessionId,m.targetEntryId);
      }
      this.db.prepare("UPDATE operations SET state='committed' WHERE id=?").run(operationId);
    });
  }
  abort(operationId:string):void { this.db.prepare("UPDATE operations SET state='aborted' WHERE id=? AND state='prepared'").run(operationId); }
}
export function defaultOriginRegistryPath(agentDir:string):string { return join(agentDir,'usage','origins.db'); }
const registries=new Map<string,UsageOriginRegistry>();
export function sharedOriginRegistry(agentDir:string):UsageOriginRegistry {
  const file=defaultOriginRegistryPath(agentDir);let r=registries.get(file);if(!r){r=new UsageOriginRegistry(file);registries.set(file,r);}return r;
}
