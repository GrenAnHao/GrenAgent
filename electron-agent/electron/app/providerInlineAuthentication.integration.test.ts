import{mkdtemp,rm,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{expect,it}from'vitest';import{ModelRuntime}from'../../../cli/src/pi-sdk';
it('canonical credentials precede legacy inline keys, which remain a fallback after explicit credential removal',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gren-inline-auth-'));try{
  await writeFile(join(root,'models.json'),JSON.stringify({providers:{openai:{apiKey:'fixture-inline'}}}));await writeFile(join(root,'auth.json'),JSON.stringify({openai:{type:'oauth',access:'fixture-access',refresh:'',expires:Number.MAX_SAFE_INTEGER}}));
  const runtime=await ModelRuntime.create({modelsPath:join(root,'models.json'),authPath:join(root,'auth.json'),modelsStorePath:join(root,'cache.json'),allowModelNetwork:false});expect(runtime.getError()).toBeUndefined();const auth=await runtime.getAuth('openai');
  const oauthSelected=auth?.auth.apiKey==='fixture-access';
  await writeFile(join(root,'auth.json'),JSON.stringify({openai:{type:'api_key',key:'fixture-auth-key'}}));await runtime.refresh();const keyed=await runtime.getAuth('openai');
  await writeFile(join(root,'auth.json'),'{}');await runtime.refresh();const cleared=await runtime.getAuth('openai');
  const facts={sdkVersion:'1.5.1',oauthSelected,canonicalKeySelected:keyed?.auth.apiKey==='fixture-auth-key',inlineFallbackAfterCredentialRemoval:cleared?.auth.apiKey==='fixture-inline'};
  await writeFile(new URL('../../../.agents/evidence/2026-11-10-complete-desktop-model-settings/inline-auth-existing-priority.json',import.meta.url),JSON.stringify(facts,null,2));expect(oauthSelected).toBe(true);expect(facts.canonicalKeySelected).toBe(true);expect(facts.inlineFallbackAfterCredentialRemoval).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
