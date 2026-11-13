import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SessionManager } from '../../../cli/src/pi-sdk.js';
import { SessionWorkflowOwner } from './sessionWorkflowOwner.js';
const dirs:string[]=[];afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'session-workflow-'));dirs.push(dir);const sm=SessionManager.create(dir,join(dir,'sessions'));const a=sm.appendMessage({role:'user',content:'original',timestamp:1});const b=sm.appendMessage({role:'user',content:'later',timestamp:2});let fail=false;const session={sessionId:sm.getSessionId(),sessionFile:sm.getSessionFile(),sessionManager:sm,isIdle:true,refreshContext(){if(fail)throw Error('refresh');},async navigateTree(id:string){const e=sm.getEntry(id)!;if(e.type==='message'&&e.message.role==='user'){e.parentId?sm.branch(e.parentId):sm.resetLeaf();return{cancelled:false,editorText:e.message.content};}sm.branch(id);return{cancelled:false};}};const owner=new SessionWorkflowOwner(dir);return{dir,sm,a,b,session,owner,fail:()=>{fail=true;}};}
it('owner rejects stale/busy and persists confirmed null-root across cold owner',async()=>{const f=await fixture();const tree=f.owner.tree(f.session as never);f.session.isIdle=false;await expect(f.owner.execute(f.session as never,{action:'label',...tree,entryId:f.a,label:'x'})).rejects.toThrow('SESSION_BUSY');f.session.isIdle=true;await expect(f.owner.execute(f.session as never,{action:'label',...tree,expectedRevision:'old',entryId:f.a,label:'x'})).rejects.toThrow('SESSION_STALE');await f.owner.execute(f.session as never,{action:'navigate',...tree,entryId:f.a,draftChoice:'keep'});expect(f.sm.getLeafId()).toBeNull();f.sm.branch(f.b);await new SessionWorkflowOwner(f.dir).restorePosition(f.session as never);expect(f.sm.getLeafId()).toBeNull();});
it('append success refresh failure closes send gate and does not append twice',async()=>{const f=await fixture();const tree=f.owner.tree(f.session as never);f.fail();const ack=await f.owner.execute(f.session as never,{action:'edit',...tree,entryId:f.a,text:'summary'});expect(ack.status).toBe('persisted-needs-reload');expect(()=>f.owner.assertSendable(f.session as never)).toThrow('SESSION_NEEDS_RELOAD');expect(f.sm.getEntries().filter(e=>e.type==='context_edit')).toHaveLength(1);await expect(f.owner.execute(f.session as never,{action:'edit',...tree,entryId:f.a,text:'summary'})).rejects.toThrow();expect(f.sm.getEntries().filter(e=>e.type==='context_edit')).toHaveLength(1);});

it('a persisted edit recovery record resumes its edit leaf instead of the earlier navigation checkpoint',async()=>{
 const f=await fixture();await f.owner.savePosition(f.session as never);const old=f.sm.getLeafId();f.fail();
 await f.owner.execute(f.session as never,{action:'edit',...f.owner.tree(f.session as never),entryId:f.a,text:'saved summary'});
 const savedLeaf=f.sm.getLeafId();expect(savedLeaf).not.toBe(old);
 const cold=SessionManager.open(f.sm.getSessionFile()!);const coldSession={...f.session,sessionManager:cold,refreshContext(){}};
 await new SessionWorkflowOwner(f.dir).restorePosition(coldSession as never);expect(cold.getLeafId()).toBe(savedLeaf);expect(cold.buildSessionProjection().messages[0]).toMatchObject({content:'saved summary'});
});

it('a truncated saved anchor is rejected and next SDK append joins an existing parent',async()=>{
 const f=await fixture();await f.owner.savePosition(f.session as never);
 const {writeFile}=await import('node:fs/promises');await writeFile(f.sm.getSessionFile()!,[f.sm.getHeader(),f.sm.getEntry(f.a)].map(e=>JSON.stringify(e)).join('\n')+'\n');
 const cold=SessionManager.open(f.sm.getSessionFile()!);const coldSession={...f.session,sessionManager:cold,refreshContext(){}};const owner=new SessionWorkflowOwner(f.dir);
 await owner.restorePosition(coldSession as never);expect(owner.tree(coldSession as never).notice).toContain('截断删除');
 const newId=cold.appendMessage({role:'user',content:'new',timestamp:3});expect(cold.getEntry(newId)?.parentId).toBe(f.a);
});

it('detached raw history respects the last confirmed position without constructing a runtime',async()=>{
 const f=await fixture();f.sm.branch(f.a);await f.owner.savePosition(f.session as never);f.sm.branch(f.b);
 const {PiRuntimeService}=await import('./piRuntimeService.js');const service=new PiRuntimeService({agentDir:f.dir,agentHost:{get:()=>undefined,open:async()=>{throw Error('must remain data-only');},close:async()=>{}} as never,modelRuntimeHost:{refresh:async()=>{}}});
 const result=await service.send(f.dir,'agent_get_messages',{targetSessionPath:f.sm.getSessionFile()}) as {messages:Array<{content:unknown}>};expect(result.messages.map(m=>m.content)).toEqual(['original']);
});
