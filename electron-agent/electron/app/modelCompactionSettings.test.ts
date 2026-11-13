import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {SettingsService} from './settingsService';
import {ModelCompactionSettingsService} from './modelCompactionSettings';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
it('reports inheritance and persisted preferences independently from per-session failures; retry does not resave',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gren-budget-settings-'));roots.push(root);const agent=join(root,'agent');await mkdir(agent);
 await writeFile(join(agent,'settings.json'),JSON.stringify({compaction:{reserveTokens:1000,modelOverrides:{'p/org/A':{keepRecentTokens:700}}}}));
 const settings=new SettingsService(root);let fail=true;
 const service=new ModelCompactionSettingsService(settings,root,agent,async()=>[{provider:'p',id:'org/A'},{provider:'p',id:'B'}],async()=>({sessions:[{workspace:'A',provider:'p',modelId:'org/A'},{workspace:'B',error:fail?'fixture failure':undefined}]}));
 let state=await service.get();expect(state.rows[0]).toMatchObject({desktop:{},inherited:{reserveTokens:1000,keepRecentTokens:700},sources:{reserveTokens:'ordinary',keepRecentTokens:'model'}});
 state=await service.patch('p','org/A',{reserveTokens:0});expect(state.rows[0].effective).toEqual({reserveTokens:0,keepRecentTokens:700});expect(state.sync.sessions[1].error).toBe('fixture failure');
 const before=await readFile(join(root,'settings.json'),'utf8');fail=false;expect((await service.retrySync()).sessions[1].error).toBeUndefined();expect(await readFile(join(root,'settings.json'),'utf8')).toBe(before);
 await settings.patchModelCompactionBudget('removed','id/with/slashes',{keepRecentTokens:0});state=await service.get();expect(state.rows[2]).toMatchObject({key:'removed/id/with/slashes',matched:false,desktop:{keepRecentTokens:0}});
 state=await service.clear('removed/id/with/slashes');expect(state.rows).toHaveLength(2);
 expect(JSON.parse(await readFile(join(agent,'settings.json'),'utf8')).compaction.reserveTokens).toBe(1000);
});

it('synchronizes two actual SDK managers independently without restarting either session',async()=>{
 const {SettingsManager}=await import('../../../cli/src/pi-sdk');
 const {attachModelCompactionControl}=await import('../../../cli/src/model-compaction-control');
 const {PiRuntimeService}=await import('./piRuntimeService');
 const root=await mkdtemp(join(tmpdir(),'gren-budget-sync-'));roots.push(root);const dirs=[join(root,'a'),join(root,'b')];await Promise.all(dirs.map(d=>mkdir(d)));
 for(const dir of dirs)await writeFile(join(dir,'settings.json'),JSON.stringify({compaction:{reserveTokens:1000,keepRecentTokens:2000}}));
 let budgets={};const sessions=dirs.map((dir,i)=>({settingsManager:SettingsManager.create(root,dir),model:{provider:'p',id:i?'B':'A'},sessionFile:join(root,`${i}.jsonl`),dispose(){}}));
 sessions.forEach((s,i)=>attachModelCompactionControl(s as never,root,dirs[i],{read:()=>budgets,watch:()=>()=>{}}));
 budgets={'p/A':{reserveTokens:0},'p/B':{reserveTokens:5}};
 await writeFile(join(dirs[1],'settings.json'),'invalid JSON');
 const pi=new PiRuntimeService({agentDir:dirs[0],agentHost:{workspaces:()=>['workspace'],list:()=>sessions.map(session=>({session})),get:()=>undefined},modelRuntimeHost:{refresh:async()=>{}}} as never);
 const result=await pi.syncModelCompactionBudgets();
 expect(result.sessions[0]).toMatchObject({provider:'p',modelId:'A',effective:{reserveTokens:0,keepRecentTokens:2000}});
 expect(result.sessions[1].error).toBeTruthy();expect(sessions[1].settingsManager.getCompactionReserveTokens(sessions[1].model)).toBe(1000);
 await writeFile(join(dirs[1],'settings.json'),JSON.stringify({compaction:{reserveTokens:1000,keepRecentTokens:2000}}));
 const retry=await pi.syncModelCompactionBudgets();expect(retry.sessions.every(s=>!s.error)).toBe(true);expect(sessions[1].settingsManager.getCompactionReserveTokens(sessions[1].model)).toBe(5);
 sessions.forEach(s=>s.dispose());
});
