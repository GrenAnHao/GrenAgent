import { resolveWikiLink } from '../../../shared/wikiLinks';
import { markdownLinks, replaceMarkdownLinks } from './markdownLinks';
import { isKnowledgeId, type Phase } from './pipeline';
export interface SourceReference { path:string; hash:string; start:number; end:number }
export interface ValidationRequest { phase: Phase; files?: Record<string,{hash:string;lines:number}>; endpoints?: string[]; relationTypes?: string[]; pageIds?: string[]; pageId?:string; observedFiles?: string[]; observedRanges?: Array<{path:string;start:number;end:number}>; stopReason?: string }
function sources(value: unknown, files: ValidationRequest['files'], observedFiles?: string[], observedRanges?: ValidationRequest['observedRanges']): void {
 if(!Array.isArray(value)||value.length===0)throw new Error('INVALID_SOURCE');
 for(const source of value){if(!source||typeof source!=='object')throw new Error('INVALID_SOURCE');const s=source as SourceReference;const f=files?.[s.path];if(!f||(observedFiles && !observedFiles.includes(s.path))||(observedRanges && !observedRanges.some(r=>r.path===s.path && r.start<=s.start && r.end>=s.end))||s.hash!==f.hash||!Number.isInteger(s.start)||!Number.isInteger(s.end)||s.start<1||s.end<s.start||s.end>f.lines)throw new Error('INVALID_SOURCE');}
}
/** Strip only safe unresolved Wiki navigation; source paths and invalid targets remain strict. */
export function normalizeWikiNavigation(payload:unknown,files:Record<string,{hash:string;lines:number}>,context:Pick<ValidationRequest,'pageId'|'pageIds'>):unknown {
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||!context.pageIds)return payload;
 const result={...(payload as Record<string,unknown>)};if(typeof result.markdown!=='string')return result;
 const warnings:Array<{code:string;page:string;target:string}>=[];const seen=new Set<string>();
 const add=(page:string,target:string)=>{const key=`${page}\0${target}`;if(!seen.has(key)){seen.add(key);warnings.push({code:'UNKNOWN_WIKI_LINK',page,target});}};
 if(Array.isArray(result.navigationWarnings))for(const warning of result.navigationWarnings){if(warning&&typeof warning==='object'&&warning.code==='UNKNOWN_WIKI_LINK'&&typeof warning.page==='string'&&warning.page===(context.pageId??'repository')&&isKnowledgeId(warning.page)&&typeof warning.target==='string'&&warning.target.length<=500&&!/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(warning.target)&&!/[?#\\\x00-\x1f\x7f]/.test(warning.target)&&!warning.target.split('/').includes('..'))add(warning.page,warning.target);}
 const remove=[];for(const link of markdownLinks(result.markdown)){
  const target=resolveWikiLink(link.url,context.pageId);if(target.kind!=='page'||context.pageIds.includes(target.pageId))continue;
  const rootPath=!target.path.split('/').includes('..')?target.path.replace(/^(?:\.\/)+/,''):undefined;
  if(files[target.resolvedPath]||rootPath&&files[rootPath])continue;
  if(link.linkStart===undefined||link.linkEnd===undefined)continue;remove.push(link);add(context.pageId??'repository',target.resolvedPath.split(/[?#]/,1)[0].slice(0,500)||'[relative target]');
 }
 result.markdown=replaceMarkdownLinks(result.markdown,[],remove);if(warnings.length)result.navigationWarnings=warnings;else delete result.navigationWarnings;return result;
}

/** Fill citation metadata only from the manifest and observed reads; unresolved links remain for strict validation. */
export function normalizeStageSources(phase: Phase, payload: unknown, files: Record<string,{hash:string;lines:number}>, observedRanges: Array<{path:string;start:number;end:number}>, context: Pick<ValidationRequest,'pageId'|'pageIds'> = {}): unknown {
 if(!payload||typeof payload!=='object'||Array.isArray(payload))return payload;
 const int=(value:unknown)=>{const n=typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;return Number.isSafeInteger(n)&&(n as number)>0?n as number:undefined;};
 const fix=(value:unknown):SourceReference[]=>{
  if(!Array.isArray(value))return [];const seen=new Set<string>();const out:SourceReference[]=[];
  for(const raw of value){
   if(!raw||typeof raw!=='object')continue;const s=raw as Record<string,unknown>;
   const path=typeof s.path==='string'?s.path.replace(/\\/g,'/').replace(/^\.\//,''):typeof s.file==='string'?s.file.replace(/\\/g,'/').replace(/^\.\//,''):undefined;
   if(!path||!files[path])continue;const ranges=observedRanges.filter(r=>r.path===path);if(!ranges.length)continue;
   let start=int(s.start??s.start_line??s.startLine??s.line),end=int(s.end??s.end_line??s.endLine)??start;
   if(start===undefined){start=ranges[0].start;end=ranges[0].end;}
   if(end===undefined||end<start)end=start;
   if(!ranges.some(r=>r.start<=start!&&r.end>=end!)){const r=ranges.find(r=>r.start<=start!&&r.end>=start!);if(!r)continue;end=Math.min(end,r.end);}
   const key=`${path}:${start}:${end}`;if(seen.has(key))continue;seen.add(key);out.push({path,hash:files[path].hash,start,end});
  }
  return out;
 };
 const result={...(payload as Record<string,unknown>)};
 if(phase==='overview'||phase==='generate'){
  result.sources=fix(result.sources);
 }
 if(phase==='generate'&&typeof result.markdown==='string'){
  const cited=result.sources as SourceReference[];
  const replacements=[];const remove=[];
  for(const link of markdownLinks(result.markdown)){
   // Some models emit source:path:line[-line]; accept only the unambiguous,
   // valid line form, then run it through the same source resolver and evidence checks.
   const colon=link.url.match(/^source:([^:?#]+):(\d+)(?:-(\d+))?$/);
   const startLine=colon?Number(colon[2]):0,endLine=colon?Number(colon[3]??colon[2]):0;
   const colonHref=colon&&Number.isSafeInteger(startLine)&&Number.isSafeInteger(endLine)&&startLine>0&&endLine>=startLine?`source:${colon[1]}#L${startLine}-L${endLine}`:undefined;
   const target=resolveWikiLink(colonHref??link.url,context.pageId);
   const path=target.kind==='source'?target.path:target.kind==='page'&&!context.pageIds?.includes(target.pageId)?(files[target.resolvedPath]?target.resolvedPath:!target.path.split('/').includes('..')?target.path.replace(/^(?:\.\/)+/,''):target.resolvedPath):undefined;
   if(!path||!files[path]){if(target.kind==='source')remove.push(link);continue;}
   const start=target.kind==='source'?target.start:undefined,end=target.kind==='source'?target.end:undefined;
   const range=observedRanges.find(r=>r.path===path&&(start===undefined||r.start<=start)&&(end===undefined||r.end>=end));
   if(!range||start!==undefined&&(!Number.isSafeInteger(start)||start<1)||end!==undefined&&(!Number.isSafeInteger(end)||end<(start??1))){if(target.kind==='source')remove.push(link);continue;}
   const source={path,hash:files[path].hash,start:start??range.start,end:end??range.end};
   if(!cited.some(s=>s.path===path&&s.start<=source.start&&s.end>=source.end))cited.push(source);
   const url=`source:${encodeURI(path).replace(/#/g,'%23').replace(/\?/g,'%3F')}#L${source.start}-L${source.end}`;
   if(link.url!==url)replacements.push({...link,url});
  }
  result.markdown=replaceMarkdownLinks(result.markdown,replacements,remove);
 }
 if((phase==='overview'||phase==='generate')&&!(result.sources as SourceReference[]).length){
  // No usable list or links, but the text names files it actually read: cite those read ranges.
  const text=String(result.markdown??result.summary??'');
  result.sources=fix(observedRanges.filter((r,i,all)=>text.includes(r.path)&&all.findIndex(x=>x.path===r.path)===i).map(r=>({path:r.path,start:r.start,end:r.end})));
 }
 if(phase==='relations'&&Array.isArray(result.relations))result.relations=result.relations.map(r=>r&&typeof r==='object'?{...r,sources:fix((r as Record<string,unknown>).sources)}:r);
 return phase==='generate'?normalizeWikiNavigation(result,files,context):result;
}
function isDefinition(value:unknown):boolean {
 if(!value||typeof value!=='object')return false;const d=value as Record<string,unknown>;
 return isKnowledgeId(d.id) && typeof d.title==='string' && !!d.title.trim() && typeof d.goal==='string' && !!d.goal.trim() && Array.isArray(d.dependencies) && d.dependencies.every(isKnowledgeId);
}
export function validateStageResult(request: ValidationRequest, value: unknown): Record<string,unknown> {
 if(request.stopReason && request.stopReason!=='stop')throw new Error('INCOMPLETE_MODEL_OUTPUT');
 if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('INVALID_STAGE_RESULT');
 const result=value as Record<string,unknown>;
 if(request.phase==='overview') {if(typeof result.summary!=='string'||!result.summary.trim())throw new Error('INVALID_OVERVIEW');sources(result.sources,request.files,request.observedFiles,request.observedRanges);}
 if(request.phase==='plan' && (!Array.isArray(result.items)||!result.items.length||!result.items.every(isDefinition)))throw new Error('INVALID_PLAN');
 if(request.phase==='catalogue' && (!Array.isArray(result.children)||!result.children.every(isDefinition)))throw new Error('INVALID_CATALOGUE');
 if(request.phase==='generate') {
  if(typeof result.markdown!=='string'||!result.markdown.trim())throw new Error('INVALID_GENERATION');sources(result.sources,request.files,request.observedFiles,request.observedRanges);
  for(const link of markdownLinks(result.markdown)){
   const target=resolveWikiLink(link.url,request.pageId);
   if(target.kind==='external'||target.kind==='anchor')continue;
   if(target.kind==='source'){
    const {path,start,end}=target;
    if(start===undefined||end===undefined||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start||!(result.sources as SourceReference[]).some(s=>s.path===path&&s.start<=start&&s.end>=end))throw new StageValidationError('INVALID_SOURCE_LINK',request.pageId,link.url);
   }else if(target.kind==='invalid'||request.pageIds&&!request.pageIds.includes(target.pageId))throw new StageValidationError('INVALID_PAGE_LINK',request.pageId,link.url);
  }
 }
 if(request.phase==='relations'){
  if(!Array.isArray(result.relations))throw new Error('INVALID_RELATIONS');const seen=new Set<string>();
  for(const value of result.relations){if(!value||typeof value!=='object')throw new Error('INVALID_RELATION');const r=value as Record<string,unknown>;const key=JSON.stringify([r.from,r.to,r.type]);if(typeof r.from!=='string'||typeof r.to!=='string'||typeof r.type!=='string'||!request.endpoints?.includes(r.from)||!request.endpoints?.includes(r.to)||r.from===r.to||!request.relationTypes?.includes(r.type)||seen.has(key))throw new Error('INVALID_RELATION');sources(r.sources,request.files,request.observedFiles,request.observedRanges);seen.add(key);}
 }
 if(request.phase==='validate' && result.valid!==true)throw new Error('VALIDATION_FAILED');
 return result;
}






/** Only a bounded relative path is included in public diagnostics; query/fragment and absolute targets are omitted. */
export class StageValidationError extends Error {
 constructor(readonly code:string,pageId?:string,target?:string){
  const relative=(value:string)=>{const path=value.replace(/^source:/,'').split(/[?#]/)[0];return !path||/^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(path)?'[non-relative target]':path.replace(/[\x00-\x1f\x7f]/g,'').slice(0,180);};
  super(`${code}: page ${relative(pageId??'repository')}${target?`; target ${relative(target)}`:''}`);
 }
}
export function stageFailure(error:unknown):{code:string;message:string;retriable:boolean}{
 if(error instanceof StageValidationError)return {code:error.code,message:error.message.slice(0,500),retriable:false};
 const diagnostic=error&&typeof error==='object'&&'code' in error?error as {code?:unknown;retriable?:unknown}:undefined;
 const raw=typeof diagnostic?.code==='string'?diagnostic.code:error instanceof Error?error.message:'';const code=/^[A-Z][A-Z0-9_]{0,99}$/.test(raw)?raw:'STAGE_FAILED';
 return {code,message:code==='BUDGET_EXHAUSTED'?'Budget exhausted':`Stage failed (${code})`,retriable:diagnostic?.retriable===true};
}
