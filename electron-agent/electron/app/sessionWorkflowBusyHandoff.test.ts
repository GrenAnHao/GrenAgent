import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {expect,it,vi} from 'vitest';
import {SessionManager} from '../../../cli/src/pi-sdk.js';import {PiRuntimeService} from './piRuntimeService.js';
it('switching away from a branch summary/preflight parks its busy SDK owner instead of aborting or replacing it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'workflow-busy-handoff-'));
 try{const source=SessionManager.create(dir,join(dir,'sessions')),target=SessionManager.create(dir,join(dir,'sessions'));source.appendMessage({role:'user',content:'source',timestamp:1});target.appendMessage({role:'user',content:'target',timestamp:2});
 const make=(manager:SessionManager,idle:boolean)=>{const session={sessionManager:manager,sessionId:manager.getSessionId(),sessionFile:manager.getSessionFile(),isStreaming:false,isIdle:idle,abort:vi.fn(async()=>{}),refreshContext(){}};return{session,getState:()=>({sessionId:session.sessionId,sessionFile:session.sessionFile}),switchSession:vi.fn(async(file:string)=>{await session.abort();const next=SessionManager.open(file);session.sessionManager=next;session.sessionId=next.getSessionId();session.sessionFile=file;return{cancelled:false};})};};
 const original=make(source,false);let foreground=original;const handles=[original];const openAdditional=vi.fn(async()=>{const extra=make(SessionManager.create(dir,join(dir,'sessions')),true);handles.push(extra);return extra;});
 const service=new PiRuntimeService({agentDir:dir,resolveWorkspace:async()=>dir,agentHost:{get:()=>foreground,open:async()=>foreground,list:()=>handles,openAdditional,focus:(_w:string,h:typeof original)=>{foreground=h;},close:async()=>{}} as never,modelRuntimeHost:{refresh:async()=>{}}});
 await service.send(dir,'agent_switch_session',{sessionPath:target.getSessionFile()});expect(openAdditional).toHaveBeenCalledOnce();expect(original.switchSession).not.toHaveBeenCalled();expect(original.session.abort).not.toHaveBeenCalled();expect(original.session.sessionId).toBe(source.getSessionId());expect(foreground.session.sessionId).toBe(target.getSessionId());
 }finally{await rm(dir,{recursive:true,force:true});}
});
