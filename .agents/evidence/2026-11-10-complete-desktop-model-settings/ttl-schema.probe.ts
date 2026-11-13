import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { ModelRuntime } from './pi-sdk';
it('SDK 1.5.1 rejects explicit unknown cache TTL', async () => {
 const root=await mkdtemp(join(tmpdir(),'gren-ttl-schema-'));
 try {
  await writeFile(join(root,'models.json'),JSON.stringify({providers:{fixture:{api:'openai-completions',baseUrl:'https://fixture.invalid/v1',models:[{id:'fixture',promptCache:{short:300,long:null}}]}}}));
  const runtime=await ModelRuntime.create({modelsPath:join(root,'models.json'),authPath:join(root,'auth.json'),modelsStorePath:join(root,'cache.json'),allowModelNetwork:false});
  await writeFile(new URL('../../.agents/evidence/2026-11-10-complete-desktop-model-settings/ttl-schema-error.json', import.meta.url), JSON.stringify({error:runtime.getError(), model:runtime.getModel('fixture','fixture')}, null, 2));
  expect(runtime.getError()).toBeDefined();
  expect(runtime.getModel('fixture','fixture')).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});

