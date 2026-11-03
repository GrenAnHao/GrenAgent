import { posix } from 'node:path';
import { isKnowledgeId, type Phase } from './pipeline';
export interface SourceReference { path:string; hash:string; start:number; end:number }
export interface ValidationRequest { phase: Phase; files?: Record<string,{hash:string;lines:number}>; endpoints?: string[]; relationTypes?: string[]; pageIds?: string[]; pageId?:string; observedFiles?: string[]; observedRanges?: Array<{path:string;start:number;end:number}>; stopReason?: string }
function sources(value: unknown, files: ValidationRequest['files'], observedFiles?: string[], observedRanges?: ValidationRequest['observedRanges']): void {
 if(!Array.isArray(value)||value.length===0)throw new Error('INVALID_SOURCE');
 for(const source of value){if(!source||typeof source!=='object')throw new Error('INVALID_SOURCE');const s=source as SourceReference;const f=files?.[s.path];if(!f||(observedFiles && !observedFiles.includes(s.path))||(observedRanges && !observedRanges.some(r=>r.path===s.path && r.start<=s.start && r.end>=s.end))||s.hash!==f.hash||!Number.isInteger(s.start)||!Number.isInteger(s.end)||s.start<1||s.end<s.start||s.end>f.lines)throw new Error('INVALID_SOURCE');}
}
/**
 * Turn model-written citations into checkable ones before validation. Real models drop or mistype
 * the 64-character hash, use start_line/end_line, or cite a file without lines; the hash comes from
 * the manifest and missing lines fall back to the range a Read actually returned. Citations that
 * still cannot be tied to read lines are dropped (Markdown links to them become plain text), so a
 * page never claims unread evidence. Validation afterwards stays strict.
 */
export function normalizeStageSources(phase: Phase, payload: unknown, files: Record<string,{hash:string;lines:number}>, observedRanges: Array<{path:string;start:number;end:number}>): unknown {
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
  result.markdown=result.markdown.replace(/\[([^\]]*)\]\(\s*<?source:([^\s)>]+)>?\s*\)/g,(all,text:string,target:string)=>{
   const m=/^([^#]+)#L(\d+)(?:-L(\d+))?$/.exec(target);let path:string;try{path=m?decodeURIComponent(m[1]):'';}catch{path='';}
   if(!m)return text;const start=Number(m[2]),end=Number(m[3]??m[2]);
   if(cited.some(s=>s.path===path&&s.start<=start&&s.end>=end))return all;
   const r=observedRanges.find(x=>x.path===path&&x.start<=start&&x.end>=end);
   if(r&&files[path]){cited.push({path,hash:files[path].hash,start,end});return all;}
   return text;
  });
 }
 if((phase==='overview'||phase==='generate')&&!(result.sources as SourceReference[]).length){
  // No usable list or links, but the text names files it actually read: cite those read ranges.
  const text=String(result.markdown??result.summary??'');
  result.sources=fix(observedRanges.filter((r,i,all)=>text.includes(r.path)&&all.findIndex(x=>x.path===r.path)===i).map(r=>({path:r.path,start:r.start,end:r.end})));
 }
 if(phase==='relations'&&Array.isArray(result.relations))result.relations=result.relations.map(r=>r&&typeof r==='object'?{...r,sources:fix((r as Record<string,unknown>).sources)}:r);
 return result;
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
  for(const match of result.markdown.matchAll(/(?:\]\(\s*<?|<|\]\s*:\s*<?)source:([^\s)>]+)/g)) { const reference=/^([^#]+)#L(\d+)(?:-L(\d+))?$/.exec(match[1]); if(!reference)throw new Error('INVALID_SOURCE_LINK'); let path:string;try{path=decodeURIComponent(reference[1]);}catch{throw new Error('INVALID_SOURCE_LINK');} const start=Number(reference[2]),end=Number(reference[3]??reference[2]);const cited=(result.sources as SourceReference[]).some(s=>s.path===path&&s.start<=start&&s.end>=end);if(!cited||end<start)throw new Error('INVALID_SOURCE_LINK'); }
  if(request.pageIds) for(const match of result.markdown.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)){if(/^[a-z][a-z0-9+.-]*:/i.test(match[1]))continue;const target=match[1].replace(/\.md$/,'');const id=request.pageId?posix.normalize(posix.join(posix.dirname(request.pageId),target)):target.replace(/^\.\//,'');if(!request.pageIds.includes(id))throw new Error('INVALID_PAGE_LINK');}
 }
 if(request.phase==='relations'){
  if(!Array.isArray(result.relations))throw new Error('INVALID_RELATIONS');const seen=new Set<string>();
  for(const value of result.relations){if(!value||typeof value!=='object')throw new Error('INVALID_RELATION');const r=value as Record<string,unknown>;const key=JSON.stringify([r.from,r.to,r.type]);if(typeof r.from!=='string'||typeof r.to!=='string'||typeof r.type!=='string'||!request.endpoints?.includes(r.from)||!request.endpoints?.includes(r.to)||r.from===r.to||!request.relationTypes?.includes(r.type)||seen.has(key))throw new Error('INVALID_RELATION');sources(r.sources,request.files,request.observedFiles,request.observedRanges);seen.add(key);}
 }
 if(request.phase==='validate' && result.valid!==true)throw new Error('VALIDATION_FAILED');
 return result;
}





