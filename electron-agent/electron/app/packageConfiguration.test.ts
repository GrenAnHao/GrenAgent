import{mkdtemp,mkdir,readFile,rm,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{afterEach,expect,it}from'vitest';import{SettingsManager}from'../../../cli/src/pi-sdk';
import{commitPackageEntry,restorePackageEntry}from'./packageConfiguration';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'gren-package-cas-'));roots.push(root);const cwd=join(root,'project'),agentDir=join(root,'agent');await mkdir(join(cwd,'.pi'),{recursive:true});await mkdir(agentDir);await writeFile(join(agentDir,'settings.json'),JSON.stringify({packages:[{source:'npm:demo-a@1.0.0',autoload:false,extensions:[],skills:['kept'],prompts:[],themes:[]}],unrelated:{keep:1}}));await writeFile(join(cwd,'.pi/settings.json'),JSON.stringify({packages:['npm:demo-a@9.0.0']}));return{root,cwd,agentDir,path:join(agentDir,'settings.json')};}
it('a selected-entry update preserves an external package appended after the preview snapshot',async()=>{
 const f=await fixture();const preview=SettingsManager.create(f.cwd,f.agentDir);const old=preview.getGlobalSettings().packages!;
 const external=SettingsManager.create(f.cwd,f.agentDir);external.setPackages([...old,'npm:demo-b@1.0.0']);await external.flush();
 await commitPackageEntry({cwd:f.cwd,agentDir:f.agentDir,scope:'user',expected:old[0],next:{...(old[0]as object),source:'npm:demo-a@2.0.0'},projectTrusted:true});
 expect(JSON.parse(await readFile(f.path,'utf8')).packages).toEqual([{...(old[0]as object),source:'npm:demo-a@2.0.0'},'npm:demo-b@1.0.0']);
});

it('rejects changed entries and preserves the other scope, unrelated settings and credential files',async()=>{
 const f=await fixture();const old={source:'npm:demo-a@1.0.0',autoload:false,extensions:[],skills:['kept'],prompts:[],themes:[]};const next={...old,source:'npm:demo-a@2.0.0'};
 await writeFile(join(f.agentDir,'auth.json'),'credential-fixture-untouched');
 await expect(commitPackageEntry({...f,scope:'project',expected:'npm:demo-a@9.0.0',next:'npm:demo-a@10.0.0',projectTrusted:false})).rejects.toThrow('PACKAGE_PROJECT_UNTRUSTED');
 await commitPackageEntry({...f,scope:'user',expected:old,next,projectTrusted:true});
 expect(JSON.parse(await readFile(f.path,'utf8')).unrelated).toEqual({keep:1});expect(JSON.parse(await readFile(join(f.cwd,'.pi/settings.json'),'utf8')).packages).toEqual(['npm:demo-a@9.0.0']);expect(await readFile(join(f.agentDir,'auth.json'),'utf8')).toBe('credential-fixture-untouched');
 await expect(commitPackageEntry({...f,scope:'user',expected:old,next,projectTrusted:true})).rejects.toThrow('PACKAGE_ENTRY_CHANGED');
 await restorePackageEntry({...f,scope:'user',expected:next,next:old,projectTrusted:true});await restorePackageEntry({...f,scope:'user',expected:next,next:old,projectTrusted:true});expect(JSON.parse(await readFile(f.path,'utf8')).packages).toEqual([old]);
});
it('uses the exact SDK lock path and does not overwrite a concurrent SDK writer',async()=>{
 const f=await fixture();const lockfile=(await import('proper-lockfile')).default;const release=await lockfile.lock(f.path,{realpath:false});
 try{const sdk=SettingsManager.create(f.cwd,f.agentDir);sdk.setDefaultModel('must-not-write-through-lock');await sdk.flush();expect(sdk.drainErrors().length).toBeGreaterThan(0);expect(JSON.parse(await readFile(f.path,'utf8')).defaultModel).toBeUndefined();}finally{await release();}
 const sdk=SettingsManager.create(f.cwd,f.agentDir);sdk.setDefaultModel('external-preserved');await sdk.flush();const old=sdk.getGlobalSettings().packages![0];await commitPackageEntry({...f,scope:'user',expected:old,next:{...(old as object),source:'npm:demo-a@2.0.0'},projectTrusted:true});expect(JSON.parse(await readFile(f.path,'utf8')).defaultModel).toBe('external-preserved');
});
