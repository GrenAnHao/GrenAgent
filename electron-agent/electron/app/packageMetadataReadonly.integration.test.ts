import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { packageUpdateFixture } from './fixtures/packageUpdates';
import { checkPackageUpdate, readPackageSnapshot } from './piPackageMetadata';
const fixtures:Array<Awaited<ReturnType<typeof packageUpdateFixture>>>=[];
afterEach(async()=>{for(const f of fixtures.splice(0))await f.cleanup();vi.unstubAllEnvs();});
it('native metadata checking never installs a tarball, changes entries/trees or runs the package lifecycle script',async()=>{
 const f=await packageUpdateFixture();fixtures.push(f);await f.install('npm:gren-demo-a@1.0.0');f.publish();
 const before=await readFile(join(f.agentDir,'settings.json'),'utf8'),scripts=await f.scripts(),requests=f.requests.length;
 const snapshot=await readPackageSnapshot({scope:'user',entry:'npm:gren-demo-a@1.0.0',installedPath:f.manager.getInstalledPath('npm:gren-demo-a','user'),managedRoot:join(f.agentDir,'npm')});
 expect(await checkPackageUpdate(snapshot,{cwd:f.cwd,npmCommand:f.npmCommand})).toMatchObject({state:'available',targetVersion:'2.0.0'});
 expect(f.requests.slice(requests).some(url=>url.endsWith('.tgz'))).toBe(false);expect(await f.scripts()).toBe(scripts);expect(await f.version('gren-demo-a')).toBe('1.0.0');expect(await readFile(join(f.agentDir,'settings.json'),'utf8')).toBe(before);
},30000);
