import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SettingsManager } from '../../../cli/src/pi-sdk';
import { attachModelCompactionControl, syncSessionModelCompactionBudget } from '../../../cli/src/model-compaction-control';
const roots:string[]=[];
const ownedSessions:Array<{dispose():void}>=[];
afterEach(async()=>{ownedSessions.splice(0).forEach(session=>session.dispose());await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'gren-budget-sdk-'));roots.push(root);const agentDir=join(root,'agent');await mkdir(agentDir);const path=join(agentDir,'settings.json');await writeFile(path,JSON.stringify({compaction:{enabled:false,reserveTokens:1000,keepRecentTokens:2000,modelOverrides:{'p/A':{keepRecentTokens:700}}},cacheWarming:'off'}));return{root,agentDir,path};}
it('clearing a desktop override must restore the inherited SDK model value',async()=>{
 const {root,agentDir}=await fixture();const manager=SettingsManager.create(root,agentDir);
 manager.applyOverrides({compaction:{modelOverrides:{'p/A':{reserveTokens:0,keepRecentTokens:25}}}});
 const session={settingsManager:manager,model:{provider:'p',id:'A'},dispose(){}};
 ownedSessions.push(session);
 const control=attachModelCompactionControl(session as never,root,agentDir,{read:()=>({}),watch:()=>()=>{}});
 // This manager holds a desktop value from the previous owner. Mark ownership before clearing.
 control.apply({'p/A':{reserveTokens:0,keepRecentTokens:25}});
 control.apply({});
 expect(manager.getCompactionSettings({provider:'p',id:'A'})).toEqual({enabled:false,reserveTokens:1000,keepRecentTokens:700});
});

it('resolves each field on A/B changes, fresh SDK edits and preserves unrelated overrides',async()=>{
 const {root,agentDir,path}=await fixture();const before=await readFile(path,'utf8');
 const manager=SettingsManager.create(root,agentDir);manager.applyOverrides({defaultThinkingLevel:'high',compaction:{enabled:false}});
 let budgets:Record<string,any>={'p/A':{reserveTokens:0}};let callback=()=>{};let off=false;
 const session={settingsManager:manager,model:{provider:'p',id:'A'},dispose(){}};
 ownedSessions.push(session);
 const control=attachModelCompactionControl(session as never,root,agentDir,{read:()=>budgets,watch:cb=>{callback=cb;return()=>{off=true;};}});
 expect(manager.getCompactionSettings(session.model)).toEqual({enabled:false,reserveTokens:0,keepRecentTokens:700});
 session.model={provider:'p',id:'B'};await syncSessionModelCompactionBudget(session as never);
 expect(manager.getCompactionSettings(session.model)).toEqual({enabled:false,reserveTokens:1000,keepRecentTokens:2000});
 await writeFile(path,JSON.stringify({compaction:{reserveTokens:555,keepRecentTokens:666}}));
 budgets={};session.model={provider:'p',id:'A'};callback();
 expect(manager.getCompactionSettings(session.model)).toEqual({enabled:false,reserveTokens:555,keepRecentTokens:666});
 expect(manager.getDefaultThinkingLevel()).toBe('high');
 expect(await readFile(path,'utf8')).not.toBe(before); // only the explicit fixture edit above writes SDK storage
 session.dispose();expect(off).toBe(true);expect(control.disposed).toBe(true);
});
it('does not mutate old callers without desktop preferences and fails closed on unreadable SDK baseline',async()=>{
 const {root,agentDir,path}=await fixture();const manager=SettingsManager.create(root,agentDir);
 const session={settingsManager:manager,model:{provider:'p',id:'A'},dispose(){}};
 ownedSessions.push(session);
 const control=attachModelCompactionControl(session as never,root,agentDir,{read:()=>({}),watch:()=>()=>{}});
 expect(manager.getGlobalSettings().compaction?.modelOverrides?.['p/A']).toEqual({keepRecentTokens:700});
 control.apply({'p/A':{reserveTokens:1}});
 await writeFile(path,'invalid JSON');
 expect(()=>control.apply({})).toThrow();
 expect(manager.getCompactionReserveTokens(session.model)).toBe(1);
});



it('legacy sessions without desktop budgets add no SettingsManager access or disposal prerequisite',()=>{
 let disposed=0;const session={model:{provider:'legacy',id:'A'},get settingsManager():never{throw new Error('legacy settings must not be touched');},dispose(){disposed++;}};
 attachModelCompactionControl(session as never,'unused-cwd','unused-agent',{read:()=>({}),watch:()=>()=>{}});session.dispose();expect(disposed).toBe(1);
});

it('local aggregation includes embedded sessions, isolates failures and unregisters disposed owners',async()=>{
 const mod=await import('../../../cli/src/model-compaction-control');expect(typeof (mod as any).syncLocalModelCompactionBudgets).toBe('function');
 const a=await fixture(),b=await fixture();let budgets:any={'p/A':{reserveTokens:1},'p/B':{keepRecentTokens:0}};
 const parent={settingsManager:SettingsManager.create(a.root,a.agentDir),model:{provider:'p',id:'A'},sessionFile:'parent.jsonl',dispose(){}};
 const embedded={settingsManager:SettingsManager.create(b.root,b.agentDir),model:{provider:'p',id:'B'},sessionFile:'embedded.jsonl',dispose(){}};ownedSessions.push(parent,embedded);
 attachModelCompactionControl(parent as never,a.root,a.agentDir,{read:()=>budgets,watch:()=>()=>{}});attachModelCompactionControl(embedded as never,b.root,b.agentDir,{read:()=>budgets,watch:()=>()=>{}});
 budgets={'p/A':{reserveTokens:2},'p/B':{keepRecentTokens:3}};await writeFile(a.path,'broken SDK settings');
 const result=await (mod as any).syncLocalModelCompactionBudgets();expect(result.sessions).toHaveLength(2);expect(result.sessions.find((s:any)=>s.sessionPath==='parent.jsonl').error).toBeTruthy();expect(result.sessions.find((s:any)=>s.sessionPath==='embedded.jsonl').effective).toEqual({reserveTokens:1000,keepRecentTokens:3});expect(parent.settingsManager.getCompactionReserveTokens(parent.model)).toBe(1);
 parent.dispose();expect((await (mod as any).syncLocalModelCompactionBudgets()).sessions).toHaveLength(1);embedded.dispose();expect((await (mod as any).syncLocalModelCompactionBudgets()).sessions).toEqual([]);
});
