import { candidateSelectionState, confirmCandidateRecovery } from './sessionCandidate.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSession, SessionManager } from '../../../cli/src/pi-sdk.js';
import { legacyExclusions, editableContent } from './sessionWorkflowData.js';
import type { SessionTreeDto, SessionTreeNodeDto, SessionWorkflowAck, SessionWorkflowRequest } from './sessionWorkflowContracts.js';

type Session = Pick<AgentSession,'sessionId'|'sessionFile'|'sessionManager'|'isIdle'|'refreshContext'|'navigateTree'|'abortBranchSummary'>;
export class SessionWorkflowOwner {
  private readonly epoch=randomUUID();
  private readonly locked=new Set<string>();
  private readonly blocked=new Set<string>();
  private readonly revisions=new WeakMap<object,{shape:string;revision:number}>();
  private readonly notices=new Map<string,string>();
  constructor(private readonly agentDir:string){}
  private key(s:Session):string{return resolve(s.sessionFile??'');}
  isLocked(s:Session):boolean{return this.locked.has(this.key(s));}
  assertSendable(s:Session):void{if(this.blocked.has(this.key(s)))throw new Error('SESSION_NEEDS_RELOAD: 已保存，请重开原会话');if(this.isLocked(s))throw new Error('SESSION_BUSY');}
  private revision(s:Session):string{const shape=`${s.sessionManager.getEntryCount()}:${s.sessionManager.getLeafId()}`;let r=this.revisions.get(s);if(!r){r={shape,revision:0};this.revisions.set(s,r);}else if(r.shape!==shape){r.shape=shape;r.revision++;}return `${this.epoch}:${r.revision}`;}
  tree(s:Session):SessionTreeDto {
    const sm=s.sessionManager,branch=new Set(sm.getBranch().map(e=>e.id)),excluded=legacyExclusions(sm.getEntries());
    const windowIds=new Set(sm.buildContextEntries().map(entry=>entry.id));
    const projected=new Map(sm.buildSessionProjection().entries.map(e=>[e.sourceEntry.id,e.messages]));
    const edits=new Map(sm.getBranch().filter(e=>e.type==='context_edit').map(e=>[e.targetId,e.replacement]));
    const walk=(node:ReturnType<typeof sm.getTree>[number]):SessionTreeNodeDto=>{
      const e=node.entry;const original=e.type==='message'&&'content' in e.message?e.message.content:e.type==='custom_message'?e.content:undefined;
      const effective=(projected.get(e.id)?.[0] as {content?:unknown}|undefined)?.content;
      const preview=typeof original==='string'?original:Array.isArray(original)?original.filter(b=>b.type==='text').map(b=>(b as {text:string}).text).join('\n'):e.type==='branch_summary'||e.type==='compaction'?e.summary:e.type;
      return {id:e.id,parentId:e.parentId,type:e.type,...(e.type==='message'?{role:e.message.role}:{}),label:node.label,preview:preview.slice(0,300),children:node.children.map(walk),current:sm.getLeafId()===e.id,onBranch:branch.has(e.id),legacyExcluded:e.type==='message'&&excluded.has(e.message.timestamp),original:structuredClone(original),effective:structuredClone(effective),replaced:edits.has(e.id)&&JSON.stringify(edits.get(e.id)?.content)!==JSON.stringify(original),inContext:!!projected.get(e.id)?.length,inWindow:windowIds.has(e.id),omitted:edits.has(e.id)&&edits.get(e.id)===null};
    };
    return {targetSessionPath:s.sessionFile??'',expectedSessionId:s.sessionId,expectedLeafId:sm.getLeafId(),expectedRevision:this.revision(s),nodes:sm.getTree().map(walk),busy:!s.isIdle,needsReload:this.blocked.has(this.key(s)),notice:this.notices.get(this.key(s))};
  }
  assertSnapshot(s:Session,r:SessionWorkflowRequest):void{
    if(!s.sessionFile||!r.targetSessionPath||resolve(r.targetSessionPath)!==this.key(s)||r.expectedSessionId!==s.sessionId||r.expectedLeafId!==s.sessionManager.getLeafId()||r.expectedRevision!==this.revision(s))throw new Error('SESSION_STALE: 会话位置已变化，请刷新预览');
  }
  private check(s:Session,r:SessionWorkflowRequest):void{
    this.assertSnapshot(s,r);
    if(!s.isIdle||this.isLocked(s))throw new Error('SESSION_BUSY');
    this.assertSendable(s);
  }
  async withTarget<T>(s:Session,r:SessionWorkflowRequest,action:()=>Promise<T>):Promise<T>{this.check(s,r);const key=this.key(s);this.locked.add(key);try{return await action();}finally{this.locked.delete(key);}}
  private positionPath(s:Pick<Session,'sessionId'>):string{return join(this.agentDir,'session-positions',`${encodeURIComponent(s.sessionId)}.json`);}
  async restoreReadOnlyPosition(manager:SessionManager,sessionPath:string):Promise<void>{
    const identity={sessionId:manager.getSessionId()};
    for(const file of [this.recoveryPath(identity),this.positionPath(identity)]){
      let record:{path?:string;leafId?:unknown};try{record=JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      if(record.path!==resolve(sessionPath))continue;
      if(record.leafId===null){manager.resetLeaf();return;}
      if(typeof record.leafId==='string'&&manager.getEntry(record.leafId)){manager.branch(record.leafId);return;}
    }
  }
  async checkpoint(s:Session):Promise<void>{
    if(!s.sessionFile||!existsSync(this.positionPath(s))||this.isLocked(s))return;
    try{await this.savePosition(s);}catch(error){this.blocked.add(this.key(s));await this.recordRecovery(s).catch(()=>{});throw error;}
  }
  async savePosition(s:Session):Promise<void>{const file=this.positionPath(s);await mkdir(join(this.agentDir,'session-positions'),{recursive:true});const temp=`${file}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify({version:1,path:this.key(s),leafId:s.sessionManager.getLeafId(),entryCount:s.sessionManager.getEntryCount()}),'utf8');await rename(temp,file);}
  private recoveryPath(s:Pick<Session,'sessionId'>):string{return join(this.agentDir,'session-positions',`${encodeURIComponent(s.sessionId)}.recovery.json`);}
  private async recordRecovery(s:Session):Promise<void>{await mkdir(join(this.agentDir,'session-positions'),{recursive:true});await writeFile(this.recoveryPath(s),JSON.stringify({path:this.key(s),leafId:s.sessionManager.getLeafId()}),'utf8');}
  async reload(s:Session,r:SessionWorkflowRequest):Promise<SessionWorkflowAck>{
    const current=this.tree(s);
    if(r.expectedSessionId!==current.expectedSessionId||r.expectedRevision!==current.expectedRevision||r.expectedLeafId!==current.expectedLeafId||r.targetSessionPath!==current.targetSessionPath)throw new Error('SESSION_STALE');
    if(!s.isIdle||this.isLocked(s))throw new Error('SESSION_BUSY');
    this.locked.add(this.key(s));
    try{await confirmCandidateRecovery(s.sessionManager,false);s.sessionManager.setSessionFile(s.sessionFile!);await this.restorePosition(s);s.refreshContext();await this.savePosition(s);await confirmCandidateRecovery(s.sessionManager);this.blocked.delete(this.key(s));this.notices.delete(this.key(s));return{status:'ok',tree:this.tree(s)};}finally{this.locked.delete(this.key(s));}
  }
  async restorePosition(s:Session):Promise<void>{
    // Legacy fork/switch-only ports have no persisted workflow metadata capability.
    if(typeof s.sessionManager?.getEntries!=='function')return;
    const candidate=await candidateSelectionState(s.sessionManager);
    if(candidate&&candidate.manifest.state!=='selected'){this.blocked.add(this.key(s));this.notices.set(this.key(s),'候选已保存但尚未完成选中；请显式恢复，尚未发布的候选不能发送');return;}
    try{
      const recovery=JSON.parse(await readFile(this.recoveryPath(s),'utf8'));
      if(recovery.path===this.key(s)&&(recovery.leafId===null||s.sessionManager.getEntry(recovery.leafId))){
        recovery.leafId===null?s.sessionManager.resetLeaf():s.sessionManager.branch(recovery.leafId);s.refreshContext();await this.savePosition(s);await rm(this.recoveryPath(s),{force:true});this.blocked.delete(this.key(s));return;
      }
    }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}

    let raw:string;try{raw=await readFile(this.positionPath(s),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
    const p=JSON.parse(raw);if(p.version!==1||p.path!==this.key(s))return;
    if(p.leafId!==null&&!s.sessionManager.getEntry(p.leafId)){this.notices.set(this.key(s),'已保存的位置被截断删除，已恢复到当前有效位置');await this.savePosition(s);return;}
    p.leafId===null?s.sessionManager.resetLeaf():s.sessionManager.branch(p.leafId);s.refreshContext();this.blocked.delete(this.key(s));
  }
  async execute(s:Session,r:SessionWorkflowRequest,afterNavigation?:()=>Promise<void>):Promise<SessionWorkflowAck>{
    if(r.action==='tree')return{status:'ok',tree:this.tree(s)};
    if(r.action==='cancel-summary'){if(r.expectedSessionId!==s.sessionId||r.targetSessionPath!==s.sessionFile)throw new Error('SESSION_STALE');s.abortBranchSummary();return{status:'cancelled'};}
    if(r.action==='navigate-preview'){
      this.check(s,r);const e=s.sessionManager.getEntry(r.entryId??'');if(!e)throw new Error('SESSION_INVALID_TARGET');
      const editable=e.type==='custom_message'||e.type==='message'&&e.message.role==='user';
      const c=e.type==='custom_message'?e.content:e.type==='message'&&'content' in e.message?e.message.content:undefined;
      return{status:'ok',targetLeafId:editable?e.parentId:e.id,editorText:editable?(typeof c==='string'?c:Array.isArray(c)?c.filter(b=>b.type==='text').map(b=>(b as {text:string}).text).join('\n'):''):undefined,tree:this.tree(s)};
    }
    return this.withTarget(s,r,async()=>{
      const sm=s.sessionManager,oldLeaf=sm.getLeafId(),oldCount=sm.getEntryCount();let appended=false;
      try{
        if(r.action==='label'){if(!sm.getEntry(r.entryId??''))throw new Error('SESSION_INVALID_TARGET');sm.appendLabelChange(r.entryId!,r.label?.trim()||undefined);appended=true;s.refreshContext();}
        else if(r.action==='edit'||r.action==='restore-original'){
          const content=editableContent(sm,r.entryId??'',r.text,r.action==='restore-original');sm.appendContextEdit(r.entryId!,{content:content as never});appended=true;s.refreshContext();
        }else if(r.action==='navigate'){
          if(!r.draftChoice)throw new Error('DRAFT_CHOICE_REQUIRED');
          const result=await s.navigateTree(r.entryId!,{summarize:r.summarize===true});
          if(result.cancelled){oldLeaf===null?sm.resetLeaf():sm.branch(oldLeaf);s.refreshContext();return{status:'cancelled'};}
          await afterNavigation?.();await this.savePosition(s);
          return{status:'ok',editorText:r.draftChoice==='replace'?result.editorText:undefined,tree:this.tree(s)};
        }else throw new Error('Unsupported session workflow action');
        await this.savePosition(s);return{status:'ok',tree:this.tree(s)};
      }catch(error){
        if(r.action==='navigate'){
          const cancelled=error instanceof Error&&error.name==='AbortError';
          if(sm.getLeafId()===oldLeaf&&sm.getEntryCount()===oldCount){if(cancelled)return{status:'cancelled'};throw error;}
          try{oldLeaf===null?sm.resetLeaf():sm.branch(oldLeaf);s.refreshContext();await afterNavigation?.();oldLeaf===null?sm.resetLeaf():sm.branch(oldLeaf);s.refreshContext();await this.savePosition(s);}catch{this.blocked.add(this.key(s));return{status:'persisted-needs-reload',notice:'导航恢复未完成，请重开原会话',tree:this.tree(s)};}
          if(cancelled)return{status:'cancelled'};
          throw error;
        }
        if(appended){this.blocked.add(this.key(s));await this.recordRecovery(s).catch(()=>{});return{status:'persisted-needs-reload',notice:`已保存，但上下文刷新未完成：${String(error)}`,tree:this.tree(s)};}
        throw error;
      }
    });
  }
}





