import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { packageUpdateFixture } from './fixtures/packageUpdates';
import { preparePackageInstallation } from './packageSdkStage';
import { readPackageSnapshot } from './piPackageMetadata';
const fixtures:Array<Awaited<ReturnType<typeof packageUpdateFixture>>>=[];
afterEach(async()=>{for(const f of fixtures.splice(0))await f.cleanup();vi.unstubAllEnvs();});
it('uses official SDK in a full isolated npm unit, preserves non-target versions and executes scripts only in stage',async()=>{
 const f=await packageUpdateFixture();fixtures.push(f);await f.install('npm:gren-demo-a@1.0.0');await f.install('npm:gren-demo-b@1.0.0');f.publish();
 const source='npm:gren-demo-a@1.0.0';const snapshot=await readPackageSnapshot({scope:'user',entry:source,installedPath:f.manager.getInstalledPath(source,'user'),managedRoot:join(f.agentDir,'npm')});
 const prepared=await preparePackageInstallation({snapshot,targetSource:'npm:gren-demo-a@2.0.0',cwd:f.cwd,agentDir:f.agentDir,npmCommand:f.npmCommand,recordsDir:join(f.agentDir,'package-operations')});
 expect(prepared.installed.installedVersion).toBe('2.0.0');expect(await f.version('gren-demo-a')).toBe('1.0.0');expect(await f.version('gren-demo-b')).toBe('1.0.0');
 expect(JSON.parse(await readFile(join(prepared.stage.record.stageRoot,'node_modules/gren-demo-b/package.json'),'utf8')).version).toBe('1.0.0');expect(await f.scripts()).toBe(2);expect(f.settings.getGlobalSettings().packages).toEqual(['npm:gren-demo-a@1.0.0','npm:gren-demo-b@1.0.0']);
},30000);
it('a stage dependency script failure leaves the real old unit and declaration untouched',async()=>{
 const f=await packageUpdateFixture();fixtures.push(f);await f.install('npm:gren-demo-a@1.0.0');f.publish('3.0.0');
 const source='npm:gren-demo-a@1.0.0';const snapshot=await readPackageSnapshot({scope:'user',entry:source,installedPath:f.manager.getInstalledPath(source,'user'),managedRoot:join(f.agentDir,'npm')});
 await expect(preparePackageInstallation({snapshot,targetSource:'npm:gren-demo-a@3.0.0',cwd:f.cwd,agentDir:f.agentDir,npmCommand:f.npmCommand,recordsDir:join(f.agentDir,'package-operations')})).rejects.toThrow('PACKAGE_INSTALLATION_PREPARE_FAILED');
 expect(await f.version('gren-demo-a')).toBe('1.0.0');expect(f.settings.getGlobalSettings().packages).toEqual([source]);
},30000);
it('stages the approved immutable git commit without resetting a dirty live checkout',async()=>{
 const f=await packageUpdateFixture();fixtures.push(f);const remote=await f.localGitRemote();const source=`git:${remote.remote}@${remote.first}`;await f.install(source);const live=f.manager.getInstalledPath(source,'user')!;
 const snapshot=await readPackageSnapshot({scope:'user',entry:source,installedPath:live,managedRoot:join(f.agentDir,'git')});
 const prepared=await preparePackageInstallation({snapshot,targetSource:`git:${remote.remote}@${remote.second}`,cwd:f.cwd,agentDir:f.agentDir,npmCommand:f.npmCommand,recordsDir:join(f.agentDir,'package-operations')});
 expect(prepared.installed.installedCommit).toBe(remote.second);expect(prepared.installed.installedVersion).toBe('1.0.0');expect(await f.git(['rev-parse','HEAD'],live)).toBe(remote.first);
 await import('node:fs/promises').then(fs=>fs.writeFile(join(live,'package.json'),'user modified'));
 await expect(preparePackageInstallation({snapshot,targetSource:`git:${remote.remote}@${remote.second}`,cwd:f.cwd,agentDir:f.agentDir,npmCommand:f.npmCommand,recordsDir:join(f.agentDir,'package-operations')})).rejects.toThrow('PACKAGE_GIT_DIRTY');expect(await readFile(join(live,'package.json'),'utf8')).toBe('user modified');
},60000);

it('keeps user and project installation units independent when staging a project target',async()=>{
 const f=await packageUpdateFixture();fixtures.push(f);await f.install('npm:gren-demo-a@1.0.0');await f.install('npm:gren-demo-a@1.0.0',true);f.publish();const source='npm:gren-demo-a@1.0.0';
 const snapshot=await readPackageSnapshot({scope:'project',workspace:f.cwd,entry:source,installedPath:f.manager.getInstalledPath(source,'project'),managedRoot:join(f.cwd,'.pi/npm')});
 const prepared=await preparePackageInstallation({snapshot,targetSource:'npm:gren-demo-a@2.0.0',cwd:f.cwd,agentDir:f.agentDir,npmCommand:f.npmCommand,recordsDir:join(f.cwd,'.pi/package-operations')});
 expect(prepared.installed.installedVersion).toBe('2.0.0');expect(await f.version('gren-demo-a','project')).toBe('1.0.0');expect(await f.version('gren-demo-a','user')).toBe('1.0.0');
},30000);
it('refuses mutable targets before staging or running any script',async()=>{
 const f=await packageUpdateFixture();fixtures.push(f);await f.install('npm:gren-demo-a@1.0.0');const source='npm:gren-demo-a@1.0.0';const snapshot=await readPackageSnapshot({scope:'user',entry:source,installedPath:f.manager.getInstalledPath(source,'user'),managedRoot:join(f.agentDir,'npm')});const before=await f.scripts();
 await expect(preparePackageInstallation({snapshot,targetSource:'npm:gren-demo-a@latest',cwd:f.cwd,agentDir:f.agentDir,npmCommand:f.npmCommand,recordsDir:join(f.agentDir,'package-operations')})).rejects.toThrow('PACKAGE_TARGET_NOT_IMMUTABLE');expect(await f.scripts()).toBe(before);
},30000);
