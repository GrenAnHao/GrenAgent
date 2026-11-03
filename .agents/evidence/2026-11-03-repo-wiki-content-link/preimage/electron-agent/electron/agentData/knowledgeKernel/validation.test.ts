import { describe, expect, it } from 'vitest';
import { normalizeStageSources, stageFailure, validateStageResult } from './validation';
const files = { 'src/a.ts': {hash:'code',lines:5}, 'README.md': {hash:'readme',lines:20}, 'docs/guide name.md':{hash:'guide',lines:10}, 'unread.md':{hash:'unread',lines:1} };
const observedRanges = [{path:'src/a.ts',start:1,end:5},{path:'README.md',start:2,end:8},{path:'docs/guide name.md',start:1,end:6}];
const request = {phase:'generate' as const,files,observedRanges,pageId:'modules/intro',pageIds:['modules/intro','modules/api']};
const page = (markdown:string) => ({markdown,sources:[{path:'src/a.ts',hash:'code',start:1,end:5}]});
const normalize = (markdown:string) => normalizeStageSources('generate',page(markdown),files,observedRanges,request) as ReturnType<typeof page>;
describe('rendered Markdown link validation',()=>{
 it('ignores code examples and unused reference definitions but validates rendered links',()=>{
  const markdown='`[fake](missing.md)`\n\n```md\n[fake](missing.md)\n```\n\n[unused]: missing.md\n\n[API][api]\n\n[api]: ./%61pi.md#overview "API"';
  expect(()=>validateStageResult(request,page(markdown))).not.toThrow();
  expect(()=>validateStageResult(request,page('[Missing][target]\n\n[target]: missing.md'))).toThrow('INVALID_PAGE_LINK');
 });
 it('normalizes read source Markdown links to verifiable citations and preserves valid Wiki links',()=>{
  const result=normalize('[README](README.md#purpose) and [Guide][guide] and [API](./api.md#overview)\n\n[guide]: docs/guide%20name.md');
  expect(result.markdown).toContain('(source:README.md#L2-L8)');
  expect(result.markdown).toContain('source:docs/guide%20name.md#L1-L6');
  expect(result.markdown).toContain('[API](./api.md#overview)');
  expect(result.sources).toEqual(expect.arrayContaining([{path:'README.md',hash:'readme',start:2,end:8},{path:'docs/guide name.md',hash:'guide',start:1,end:6}]));
  expect(()=>validateStageResult(request,result)).not.toThrow();
 });
 it('rejects unverified Wiki links while preserving the legacy plain-text fallback for explicit source links',()=>{
  for(const markdown of ['[unread](unread.md)','[escape](../../README.md)']){
   const result=normalize(markdown);expect(result.markdown).toBe(markdown);
   expect(()=>validateStageResult(request,result)).toThrow(/INVALID_(PAGE|SOURCE)_LINK/);
  }
  const source=normalize('[good](README.md#purpose) and [bad](source:README.md#L9-L12)');expect(source.markdown).toBe('[good](source:README.md#L2-L8) and bad');expect(()=>validateStageResult(request,source)).not.toThrow();
 });
 it('uses source line links as sources, including reference links, while preserving code text exactly',()=>{
  const markdown='`[fake](source:unread.md#L1)`\n\n[readme][readme]\n\n[readme]: README.md#L2-L4';
  const result=normalize(markdown);expect(result.markdown).toContain('`[fake](source:unread.md#L1)`');expect(result.markdown).toContain('source:README.md#L2-L4');
  expect(()=>validateStageResult(request,result)).not.toThrow();
 });
 it('rewrites a shared reference destination only once without corrupting either link',()=>{
  const result=normalize('[one][readme] and [two][readme]\n\n[readme]: README.md#purpose');
  expect(result.markdown).toBe('[one][readme] and [two][readme]\n\n[readme]: source:README.md#L2-L8');
  expect(()=>validateStageResult(request,result)).not.toThrow();
 });
 it('resolves nested source paths safely while prioritizing real Wiki pages',()=>{
  const nested={...request,pageId:'chapters/start',pageIds:['chapters/start','README']};
  const cited=normalizeStageSources('generate',page('[read](../README.md#purpose)'),files,observedRanges,{...nested,pageIds:['chapters/start']}) as ReturnType<typeof page>;
  expect(cited.markdown).toBe('[read](source:README.md#L2-L8)');
  expect(()=>validateStageResult({...nested,pageIds:['chapters/start']},cited)).not.toThrow();
  const wiki=normalizeStageSources('generate',page('[read](../README.md#purpose)'),files,observedRanges,nested) as ReturnType<typeof page>;
  expect(wiki.markdown).toBe('[read](../README.md#purpose)');expect(()=>validateStageResult(nested,wiki)).not.toThrow();
  const ambiguousFiles={...files,'chapters/README.md':{hash:'nested',lines:3}};
  const ambiguous=normalizeStageSources('generate',page('[read](README.md)'),ambiguousFiles,observedRanges,nested) as ReturnType<typeof page>;
  expect(ambiguous.markdown).toBe('[read](README.md)');expect(()=>validateStageResult({...nested,files:ambiguousFiles},ambiguous)).toThrow('INVALID_PAGE_LINK');
  const escape=normalizeStageSources('generate',page('[escape](../../README.md)'),files,observedRanges,nested) as ReturnType<typeof page>;
  expect(escape.markdown).toBe('[escape](../../README.md)');expect(()=>validateStageResult(nested,escape)).toThrow('INVALID_PAGE_LINK');
 });
 it('removes only safe unknown navigation wrappers and records auditable warnings',()=>{
  const markdown='[**Lost** `code`](missing.md?secret=hidden) and `[fake](missing.md)`\n\n[ref][id]\n\n[id]: other';
  expect(()=>validateStageResult(request,page(markdown))).toThrow('INVALID_PAGE_LINK');
  const result=normalize(markdown) as any;
  expect(result.markdown).toContain('**Lost** `code` and `[fake](missing.md)`');expect(result.markdown).toContain('ref');
  expect(result.navigationWarnings).toEqual([{code:'UNKNOWN_WIKI_LINK',page:'modules/intro',target:'modules/missing.md'},{code:'UNKNOWN_WIKI_LINK',page:'modules/intro',target:'modules/other'}]);
  expect(JSON.stringify(result.navigationWarnings)).not.toContain('secret');expect(()=>validateStageResult(request,result)).not.toThrow();
  const forged=normalizeStageSources('generate',{...page('# text'),navigationWarnings:[{code:'UNKNOWN_WIKI_LINK',page:'other',target:'fake'}]},files,observedRanges,request) as any;expect(forged.navigationWarnings).toBeUndefined();
  const forbidden=normalize('[outside](../../escape.md)');expect(()=>validateStageResult(request,forbidden)).toThrow('INVALID_PAGE_LINK');
  const unread=normalize('[unread](../unread.md)');expect(()=>validateStageResult(request,unread)).toThrow('INVALID_PAGE_LINK');
 });
 it('keeps machine error codes separate and reports only safe relative page and target details',()=>{
  try{validateStageResult(request,page('[missing](missing.md?token=secret#anchor)'));throw new Error('expected failure');}catch(error){
   expect(error).toMatchObject({code:'INVALID_PAGE_LINK'});expect((error as Error).message).toContain('modules/intro');expect((error as Error).message).toContain('missing.md');expect((error as Error).message).not.toContain('secret');
  }
  expect(stageFailure({code:'MODEL_HTTP_503',message:'MODEL_HTTP_503',retriable:true})).toEqual({code:'MODEL_HTTP_503',message:'Stage failed (MODEL_HTTP_503)',retriable:true});
  expect(stageFailure({code:'C:\\private\\repo\\file.md?token=secret',message:'secret',retriable:true})).toEqual({code:'STAGE_FAILED',message:'Stage failed (STAGE_FAILED)',retriable:true});
  expect(stageFailure(new Error('C:\\private\\repo\\file.md?token=secret'))).toEqual({code:'STAGE_FAILED',message:'Stage failed (STAGE_FAILED)',retriable:false});
 });
});
it('normalizes source colon line citations only with verified manifest and Read ranges',()=>{
 const result=normalize('[one](source:README.md:2) [range](source:README.md:3-5) [encoded](source:docs/guide%20name.md:1-6)');
 expect(result.markdown).toBe('[one](source:README.md#L2-L2) [range](source:README.md#L3-L5) [encoded](source:docs/guide%20name.md#L1-L6)');
 expect(()=>validateStageResult(request,result)).not.toThrow();
 const unverified=normalize('[unread](source:unread.md:1) [range](source:README.md:1-9)');expect(unverified.markdown).toBe('unread range');
 for(const link of ['source:../../README.md:1','source:/README.md:1','source:https://host/a:1','source:README.md:0','source:README.md:5-2','source:README.md:2?secret=x']){
  const result=normalize(`[x](${link})`);expect(()=>validateStageResult(request,result)).toThrow();
 }
});
