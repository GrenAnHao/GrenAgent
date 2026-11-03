export interface Snapshot { hashes: Record<string,string>; edges: [string,string][]; coverage: 'complete'|'partial'|'unknown'; commit?: string|null; scannerHash?: string; scopeHash?: string; planHash?: string }
export interface DeltaDefinition { id:string; sources:string[]; dependencies:string[]; scopes?:string[]; inputHash?:string }
export interface DeltaPlan { kind:'noop'|'advance'|'replan'|'affected'|'blocked'; reused:string[]; invalidated:string[]; deleted:string[]; reasons:Record<string,string> }
/** Search/list observations cover every file below the directory, including future additions. */
export function scopeContains(scope:string,path:string):boolean {
 const normalized=scope.replace(/\\/g,'/').replace(/^\.\//,'').replace(/\/$/,'');
 if(!normalized||normalized==='.')return true;
 const wildcard=normalized.search(/[*?\[]/);
 if(wildcard>=0)return path.startsWith(normalized.slice(0,wildcard));
 return path===normalized||path.startsWith(`${normalized}/`);
}
export function observedScopeChanged(scope:string,baseline:Record<string,string>,current:Record<string,string>):boolean {
 return [...new Set([...Object.keys(baseline),...Object.keys(current)])].some(path=>scopeContains(scope,path)&&baseline[path]!==current[path]);
}
export function analyseKnowledgeDelta(baseline:Snapshot,current:Snapshot,definitions:DeltaDefinition[]):DeltaPlan {
 const reasons:Record<string,string>={}; const result=(kind:DeltaPlan['kind'],invalidated:string[]=[],deleted:string[]=[]):DeltaPlan=>({kind,invalidated,deleted,reused:definitions.map(d=>d.id).filter(id=>!invalidated.includes(id)),reasons});
 if(current.coverage!=='complete'||baseline.coverage!=='complete'){reasons.coverage='incomplete source scan';return result('blocked');}
 const changed=new Set([...Object.keys(baseline.hashes),...Object.keys(current.hashes)].filter(p=>baseline.hashes[p]!==current.hashes[p]));
 const removed=[...changed].filter(p=>!(p in current.hashes));
 const structural=[...changed].some(p=>/(^|\/)(readme(?:\..*)?|package\.json|cargo\.toml|go\.mod|pyproject\.toml|wiki_plan\.json|(?:index|main|app|server)\.[^/]+)$/i.test(p))|| (()=>{const dirs=(hashes:Record<string,string>)=>new Set(Object.keys(hashes).flatMap(p=>{const parts=p.split('/');return parts.slice(0,-1).map((_,i)=>parts.slice(0,i+1).join('/'));}));const a=dirs(baseline.hashes),b=dirs(current.hashes);if([...a].some(d=>!b.has(d))||[...b].some(d=>!a.has(d)))return true;const added=[...changed].filter(p=>!(p in baseline.hashes));return removed.some(p=>added.some(q=>baseline.hashes[p]===current.hashes[q]));})();
 if(baseline.scannerHash!==current.scannerHash||baseline.scopeHash!==current.scopeHash||baseline.planHash!==current.planHash||structural){reasons.plan='structure or configuration changed';return result('replan',definitions.map(d=>d.id),removed);}
 if(!changed.size)return result(baseline.commit===current.commit?'noop':'advance');
 let grew=true; const edges=[...baseline.edges,...current.edges];while(grew){grew=false;for(const [from,to] of edges)if(changed.has(to)&&!changed.has(from)){changed.add(from);grew=true;}}
 const invalid=new Set<string>(); for(const d of definitions)if((!d.sources.length && !d.scopes?.length)||d.sources.some(p=>changed.has(p))||d.scopes?.some(scope=>[...changed].some(p=>scopeContains(scope,p)))){invalid.add(d.id);reasons[d.id]='source or search scope changed';}
 grew=true;while(grew){grew=false;for(const d of definitions)if(!invalid.has(d.id)&&d.dependencies.some(x=>invalid.has(x))){invalid.add(d.id);reasons[d.id]='dependency changed';grew=true;}}
 return result(invalid.size?'affected':'advance',[...invalid],removed);
}
export interface RepairParent {taskId:string;identity:string;items:{id:string;status:string;inputHash:string}[]}
export function prepareRepair(parent:RepairParent,current:{taskId:string;identity:string;inputs:Record<string,string>}) {
 if(!current.taskId||current.taskId===parent.taskId)throw new Error('REPAIR_REQUIRES_NEW_TASK');
 const reused:string[]=[],redo:string[]=[];for(const item of parent.items)(parent.identity===current.identity&&item.status==='validated'&&current.inputs[item.id]===item.inputHash?reused:redo).push(item.id);
 return {taskId:current.taskId,retryOf:parent.taskId,reused,redo,confirmationRequired:parent.identity!==current.identity || parent.items.some(item=>current.inputs[item.id]!==item.inputHash)};
}




