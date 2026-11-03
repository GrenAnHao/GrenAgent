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
 it('rejects unread sources and unknown pages without silently deleting the link',()=>{
  for(const markdown of ['[unknown](missing.md)','[unread](unread.md)','[escape](../../README.md)','[bad](source:README.md#L9-L12)']){
   const result=normalize(markdown);expect(result.markdown).toBe(markdown);
   expect(()=>validateStageResult(request,result)).toThrow(/INVALID_(PAGE|SOURCE)_LINK/);
  }
 });
 it('uses source line links as sources, including reference links, while preserving code text exactly',()=>{
  const markdown='`[fake](source:unread.md#L1)`\n\n[readme][readme]\n\n[readme]: README.md#L2-L4';
  const result=normalize(markdown);expect(result.markdown).toContain('`[fake](source:unread.md#L1)`');expect(result.markdown).toContain('source:README.md#L2-L4');
  expect(()=>validateStageResult(request,result)).not.toThrow();
 });
 it('keeps machine error codes separate and reports only safe relative page and target details',()=>{
  try{validateStageResult(request,page('[missing](missing.md?token=secret#anchor)'));throw new Error('expected failure');}catch(error){
   expect(error).toMatchObject({code:'INVALID_PAGE_LINK'});expect((error as Error).message).toContain('modules/intro');expect((error as Error).message).toContain('missing.md');expect((error as Error).message).not.toContain('secret');
  }
  expect(stageFailure(new Error('C:\\private\\repo\\file.md?token=secret'))).toEqual({code:'STAGE_FAILED',message:'Stage failed (STAGE_FAILED)',retriable:false});
 });
});
