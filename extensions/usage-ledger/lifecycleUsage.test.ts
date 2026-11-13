import {mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{expect,it}from'vitest';
import{UsageLedger}from'./ledger.js';import{UsageOriginRegistry}from'./originRegistry.js';import{createUsageLedgerExtension}from'./index.js';
it('CLI lifecycle baseline never grants inherited usage; later persisted warms are delayed and idempotent',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cli-warm-lifecycle-'));const ledger=new UsageLedger(join(dir,'ledger.db'));const registry=new UsageOriginRegistry(join(dir,'origins.db'));const handlers:Record<string,Function>={};const entry=(id:string)=>({type:'usage',kind:'cache_warm',id,timestamp:'2026-11-10T00:00:00Z',provider:'p',model:'m',usage:{input:1,output:1,cost:{total:0.12,totalFromProvider:true}}});const entries=[entry('inherited')];
 const ctx:any={cwd:dir,sessionManager:{getSessionId:()=> 'cli',getSessionFile:()=>null,getEntries:()=>entries}};
 try{createUsageLedgerExtension({ledger:()=>ledger,registry:()=>registry})( {on:(event:string,fn:Function)=>{handlers[event]=fn;}} as any );
 handlers.session_start({},ctx);entries.push(entry('new'));expect(ledger.report().warmingTotals.messages).toBe(0);
 handlers.agent_end({},ctx);handlers.session_shutdown({},ctx);expect(ledger.report().warmingTotals).toMatchObject({messages:1,cost:0.12});
 expect(registry.resolveUsageOrigin({sessionId:'cli',entryId:'inherited'})).toEqual({kind:'unverified'});expect(registry.resolveUsageOrigin({sessionId:'cli',entryId:'new'})).toMatchObject({kind:'local-origin'});
 }finally{ledger.close();registry.close();rmSync(dir,{recursive:true,force:true});}
});
