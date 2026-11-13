import { randomUUID } from 'node:crypto';
import { SessionManager, sessionEntryToContextMessages } from '../../../cli/src/pi-sdk.js';
import { readSessionPreferences, SESSION_PREFERENCES_ENTRY } from '../../../extensions/_shared/session-preferences.js';

type Entry = ReturnType<SessionManager['getEntries']>[number];
type Header = NonNullable<ReturnType<SessionManager['getHeader']>>;
export interface SessionDocument { header: Header; entries: Entry[] }
const supported = new Set(['message','thinking_level_change','model_change','usage','compaction','branch_summary','custom','custom_message','context_edit','label','session_info']);
function fail(line: number, why: string): never { throw new Error(`JSONL line ${line}: ${why}`); }
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x==='object' && !Array.isArray(x);
export function validContent(content: unknown): boolean {
  return typeof content==='string' || Array.isArray(content) && content.every(b=>{
    if(!isObject(b))return false;
    if(b.type==='text')return typeof b.text==='string';
    if(b.type==='thinking')return typeof b.thinking==='string';
    if(b.type==='image')return typeof b.data==='string'&&typeof b.mimeType==='string';
    if(b.type==='toolCall')return typeof b.id==='string'&&typeof b.name==='string'&&isObject(b.arguments);
    return false;
  });
}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
function usageShape(value:unknown):boolean {
  if(!isObject(value)||!['input','output','cacheRead','cacheWrite','totalTokens'].every(key=>finite(value[key]))||!isObject(value.cost))return false;
  if(!['input','output','cacheRead','cacheWrite','total'].every(key=>finite((value.cost as Record<string,unknown>)[key])))return false;
  return ['reasoning','cacheWrite1h'].every(key=>value[key]===undefined||finite(value[key]))&&(value.cost.totalFromProvider===undefined||typeof value.cost.totalFromProvider==='boolean');
}
function roleContent(role:string,content:unknown,replacement=false):boolean {
  const allowed:Record<string,string[]>={system:['text'],user:['text','image'],assistant:['text','thinking','toolCall'],toolResult:['text','image'],custom:['text','image']};
  if(!allowed[role]||!validContent(content))return false;
  if(typeof content==='string')return replacement||role!=='assistant'&&role!=='toolResult';
  return Array.isArray(content)&&content.every(block=>allowed[role].includes(block.type));
}
function validateMessage(message:Record<string,unknown>,line:number):void {
  const role=String(message.role);
  if(!['system','user','assistant','toolResult','bashExecution','custom'].includes(role)||!finite(message.timestamp))fail(line,'invalid message role/timestamp');
  if(role==='bashExecution'){
    if(typeof message.command!=='string'||typeof message.output!=='string'||typeof message.cancelled!=='boolean'||typeof message.truncated!=='boolean'||message.exitCode!==undefined&&!finite(message.exitCode))fail(line,'invalid bashExecution fields');
    return;
  }
  if(!roleContent(role,message.content))fail(line,`invalid ${role} content`);
  if(role==='assistant'){
    for(const field of ['api','provider','model'])if(typeof message[field]!=='string'||!message[field])fail(line,`invalid assistant ${field}`);
    if(!usageShape(message.usage))fail(line,'invalid assistant usage');
    if(!['pending','stop','length','toolUse','error','aborted','deferred'].includes(String(message.stopReason)))fail(line,'invalid assistant stopReason');
    for(const field of ['responseModel','responseId','thinkingLevel','providerThinkingLevel','errorMessage','rawStopReason'])if(message[field]!==undefined&&typeof message[field]!=='string')fail(line,`invalid assistant ${field}`);
    if(message.diagnostics!==undefined&&!Array.isArray(message.diagnostics))fail(line,'invalid assistant diagnostics');
    if(message.stopReason==='deferred'&&(!isObject(message.deferred)||!['provider','modelId','api','id'].every(key=>typeof (message.deferred as Record<string,unknown>)[key]==='string')))fail(line,'invalid assistant deferred handle');
  }
  if(role==='toolResult'){
    if(typeof message.toolCallId!=='string'||typeof message.toolName!=='string'||typeof message.isError!=='boolean')fail(line,'invalid toolResult identity/isError');
    if(message.usage!==undefined&&!usageShape(message.usage))fail(line,'invalid toolResult usage');
  }
  if(role==='custom'&&(typeof message.customType!=='string'||typeof message.display!=='boolean'))fail(line,'invalid custom message fields');
  if(role==='system'){
    if(message.sections!==undefined&&(!isObject(message.sections)||!Object.values(message.sections).every(value=>value===null||typeof value==='string')))fail(line,'invalid system sections');
    if(message.toolsAdded!==undefined&&(!Array.isArray(message.toolsAdded)||!message.toolsAdded.every(tool=>isObject(tool)&&typeof tool.name==='string'&&typeof tool.description==='string'&&isObject(tool.parameters))))fail(line,'invalid system toolsAdded');
    if(message.toolsRemoved!==undefined&&(!Array.isArray(message.toolsRemoved)||!message.toolsRemoved.every(tool=>isObject(tool)&&typeof tool.name==='string')))fail(line,'invalid system toolsRemoved');
  }
}
/** Deliberately stricter than SDK's tolerant loader; this runs before any runtime exists. */
export function strictSessionJsonl(raw: string): SessionDocument {
  if(Buffer.byteLength(raw,'utf8')>32*1024*1024)throw new Error('JSONL exceeds 32 MiB');
  let rows: Record<string, unknown>[]=[];
  const sourceLines:number[]=[];
  for(const [i,line] of raw.split(/\r?\n/).entries()) {
    if(!line.trim())continue;
    if(Buffer.byteLength(line)>4*1024*1024)fail(i+1,'entry exceeds 4 MiB');
    let value: unknown;try{value=JSON.parse(line);}catch{fail(i+1,'invalid JSON');}
    if(!isObject(value))fail(i+1,'expected object');
    rows.push(value);sourceLines.push(i+1);
  }
  let header=rows.shift();const headerLine=sourceLines.shift() ?? 1;
  if(!header || header.type!=='session'||typeof header.id!=='string'||!header.id||typeof header.cwd!=='string'||typeof header.timestamp!=='string')fail(headerLine,'invalid session header');
  const version=header.version ?? 1;
  if(version!==1&&version!==2&&version!==3)fail(headerLine,'unsupported version (supported 1–3)');
  if(version!==3){
    const migrated=SessionManager.inMemory(header.cwd as string,{},[header,...rows] as never);
    header=migrated.getHeader() as unknown as Record<string,unknown>;
    rows=migrated.getEntries() as unknown as Record<string,unknown>[];
  }
  const seen=new Map<string,Record<string,unknown>>();
  for(const [i,e] of rows.entries()) {
    if(!supported.has(String(e.type)))fail(sourceLines[i],'unsupported entry type');
    if(typeof e.id!=='string'||!e.id||typeof e.timestamp!=='string'||!(e.parentId===null||typeof e.parentId==='string'))fail(sourceLines[i],'invalid id/timestamp/parent');
    if(seen.has(e.id))fail(sourceLines[i],`duplicate ID ${e.id}`);
    if(e.parentId!==null&&!seen.has(String(e.parentId)))fail(sourceLines[i],`missing or forward parent ${e.parentId}`);
    if(e.type==='message'){if(!isObject(e.message))fail(sourceLines[i],'invalid message');validateMessage(e.message,sourceLines[i]);}
    if(e.type==='custom'&&typeof e.customType!=='string')fail(sourceLines[i],'invalid customType');
    if(e.type==='thinking_level_change'&&typeof e.thinkingLevel!=='string')fail(sourceLines[i],'invalid thinkingLevel');
    if(e.type==='model_change'&&(typeof e.provider!=='string'||typeof e.modelId!=='string'))fail(sourceLines[i],'invalid model identity');
    if(e.type==='usage'&&(typeof e.kind!=='string'||typeof e.provider!=='string'||typeof e.model!=='string'||!usageShape(e.usage)))fail(sourceLines[i],'invalid usage entry');
    if((e.type==='compaction'||e.type==='branch_summary')&&typeof e.summary!=='string')fail(sourceLines[i],'invalid summary');
    if(e.type==='message'&&isObject(e.message)&&e.message.role==='toolResult'){
      let parent:unknown=e.parentId,found=false;
      while(typeof parent==='string'){
        const ancestor=seen.get(parent);const message=ancestor?.message;
        if(isObject(message)&&message.role==='assistant'&&Array.isArray(message.content)&&message.content.some(b=>isObject(b)&&b.type==='toolCall'&&b.id===(e.message as Record<string,unknown>).toolCallId)){found=true;break;}
        parent=ancestor?.parentId;
      }
      if(!found)fail(sourceLines[i],'orphan toolResult: matching toolCall is missing');
    }
    if(e.type==='custom_message'&&(!roleContent('custom',e.content)||typeof e.customType!=='string'||typeof e.display!=='boolean'))fail(sourceLines[i],'invalid custom content/fields');
    if(e.type==='context_edit'||e.type==='label') {
      const target=seen.get(String(e.targetId)); if(!target)fail(sourceLines[i],`invalid target ${e.targetId}`);
      if(e.type==='context_edit') {
        if(!['message','custom_message'].includes(String(target.type))||target.type==='message'&&(!isObject(target.message)||!['user','assistant','toolResult','custom'].includes(String(target.message.role))))fail(sourceLines[i],'context edit target is not editable');
        let p:unknown=e.parentId;let ancestor=false;while(typeof p==='string'){if(p===e.targetId){ancestor=true;break;}p=seen.get(p)?.parentId;}
        if(!ancestor)fail(sourceLines[i],'context edit target is not an ancestor');
        if(e.replacement!==null&&(!isObject(e.replacement)||!roleContent(target.type==='custom_message'?'custom':String((target.message as Record<string,unknown>).role),e.replacement.content,true)))fail(sourceLines[i],'invalid replacement content');
      }
    }
    if(e.type==='compaction'){
      if(!finite(e.tokensBefore)||typeof e.firstKeptEntryId!=='string')fail(sourceLines[i],'invalid compaction tokensBefore/firstKeptEntryId');
      let p:unknown=e.parentId,found=e.firstKeptEntryId===e.id;while(!found&&typeof p==='string'){if(p===e.firstKeptEntryId){found=true;break;}p=seen.get(p)?.parentId;}
      if(!found)fail(sourceLines[i],'invalid compaction firstKeptEntryId');
      if(e.systemMessage!==undefined){if(!isObject(e.systemMessage)||e.systemMessage.role!=='system')fail(sourceLines[i],'invalid compaction systemMessage');validateMessage(e.systemMessage,sourceLines[i]);}
    }
    if(e.type==='branch_summary'&&!(e.fromId===null||typeof e.fromId==='string'))fail(sourceLines[i],'invalid branch summary fromId');
    if((e.type==='branch_summary'||e.type==='compaction')&&e.usage!==undefined&&!usageShape(e.usage))fail(sourceLines[i],'invalid summary usage');
    seen.set(e.id,e);
  }
  const projection=SessionManager.inMemory(header.cwd as string,{},[header,...rows] as never).buildSessionProjection();
  const calls=new Set<string>();
  for(const entry of projection.entries)for(const message of entry.messages){
    if(message.role==='assistant'&&Array.isArray(message.content))for(const block of message.content)if(block.type==='toolCall')calls.add(block.id);
    if(message.role==='toolResult'&&!calls.has(message.toolCallId))fail(sourceLines[rows.findIndex(e=>e.id===entry.sourceEntry.id)] ?? headerLine,'effective orphan toolResult after context edit');
  }
  return {header:header as unknown as Header,entries:rows as unknown as Entry[]};
}
export function legacyExclusions(entries: readonly Entry[]): Set<number> {
  const result=new Set<number>();
  for(const e of entries)if(e.type==='custom'&&e.customType==='context_exclusion') {
    const d=e.data as {op?:string;ts?:number};
    if(d&&typeof d.ts==='number'&&Number.isFinite(d.ts)){if(d.op==='add')result.add(d.ts);else if(d.op==='remove')result.delete(d.ts);}
  }
  return result;
}
export function branchSnapshot(sm: SessionManager, leafId: string|null=sm.getLeafId()): SessionDocument {
  const path=leafId===null?[]:sm.getBranch(leafId);
  const independent=SessionManager.inMemory(sm.getCwd(),{},[structuredClone(sm.getHeader()!),...structuredClone(sm.getEntries())]);
  if(leafId!==null)independent.createBranchedSession(leafId);
  const entries=leafId===null?[]:independent.getEntries();
  let parentId=entries.at(-1)?.id??null;
  const append=(e:Record<string,unknown>)=>{const x={...e,id:randomUUID(),parentId,timestamp:new Date().toISOString()} as unknown as Entry;entries.push(x);parentId=x.id;};  const full=legacyExclusions(sm.getEntries()),partial=legacyExclusions(entries);
  const timestamps=new Set(path.flatMap(e=>e.type==='message'&&typeof e.message.timestamp==='number'?[e.message.timestamp]:[]));
  for(const ts of timestamps)if(full.has(ts)!==partial.has(ts))append({type:'custom',customType:'context_exclusion',data:{op:full.has(ts)?'add':'remove',ts,snapshotCompensation:true}});
  const preferences=readSessionPreferences(sm.getEntries() as never);
  if(preferences)append({type:'custom',customType:SESSION_PREFERENCES_ENTRY,data:preferences});
  return {header:structuredClone(sm.getHeader()!),entries};
}
function rawContent(entry: Entry): unknown {return entry.type==='message'&&'content' in entry.message?entry.message.content:entry.type==='custom_message'?entry.content:undefined;}
function preserveBlocks(entry: unknown, content: unknown): void {
  const e=entry as Entry,original=rawContent(e);
  const nonText=(x:unknown)=>Array.isArray(x)?x.filter(b=>b?.type!=='text'):[];
  if(JSON.stringify(nonText(original))!==JSON.stringify(nonText(content)))throw new Error('Cannot remove or alter tool/signature/image protocol blocks');
}
export function editableContent(sm: SessionManager, entryId: string, text?: string, restore=false): unknown {
  const target=sm.getEntry(entryId);
  if(!target||!sm.getBranch().some(e=>e.id===entryId))throw new Error('Target is not on current branch');
  if(target.type==='message'&&!['user','assistant','toolResult','custom'].includes(target.message.role))throw new Error('Entry is not an editable context target');
  const original=rawContent(target);
  if(!validContent(original))throw new Error('Entry does not contribute editable content');
  if(!restore&&target.type==='message'&&legacyExclusions(sm.getEntries()).has(target.message.timestamp))throw new Error('请先恢复旧版会话排除，再编辑上下文');
  if(restore)return structuredClone(original);
  if(typeof text!=='string')throw new Error('text is required');
  if(typeof original==='string')return text;
  const active=(sm.buildSessionProjection().entries.find(e=>e.sourceEntry.id===entryId)?.messages[0] as {content?:unknown}|undefined)?.content??original;
  if(!Array.isArray(active))return text;
  let inserted=false;
  const result=active.flatMap(block=>{if(block.type!=='text')return [structuredClone(block)];if(inserted)return [];inserted=true;return [{...block,text}];});
  if(!inserted)throw new Error('Entry has no editable text block');
  preserveBlocks(target,result);return result;
}





export function workflowHistoryMessages(sm:SessionManager):Array<Record<string,unknown>&{entryId:string}>{
  const all=sm.getEntries();let marker=-1;
  for(let i=all.length-1;i>=0;i--){const e=all[i];if(e.type==='custom'&&e.customType==='usage_origin_required'&&(e.data as {version?:unknown})?.version===1){marker=i;break;}}
  const inherited=new Set(marker<0?[]:all.slice(0,marker).map(e=>e.id));
  const latest=new Map(sm.getBranch().filter(e=>e.type==='context_edit').map(e=>[e.targetId,e.replacement]));
  const excluded=legacyExclusions(sm.getEntries());
  const projected=new Map(sm.buildSessionProjection().entries.map(entry=>[entry.sourceEntry.id,entry.messages]));
  return sm.getBranch().flatMap(raw=>sessionEntryToContextMessages(raw).map(message=>{
    const original=rawContent(raw),replacement=latest.get(raw.id),effective=projected.get(raw.id);
    const contextReplaced=latest.has(raw.id)&&JSON.stringify(replacement?.content)!==JSON.stringify(original);
    const effectiveMessage=effective?.[0];
    return {...message,entryId:raw.id,...(inherited.has(raw.id)?{historyOnly:true}:{}),inContext:Boolean(effective?.length),...(original!==undefined?{content:structuredClone(original)}:{}),...(contextReplaced?{contextReplaced:true,effectiveContent:effectiveMessage&&'content' in effectiveMessage?structuredClone(effectiveMessage.content):undefined}:{}),...(latest.has(raw.id)&&replacement===null?{contextOmitted:true}:{}),...(raw.type==='message'?{legacyExcluded:excluded.has(raw.message.timestamp)}:{})};
  }));
}

export function derivedSelection(sm:SessionManager,operation:'fork'|'clone',entryId?:string,position:'before'|'at'='before'):{leafId:string|null;editorText?:string;entries:Entry[]}{
  let leafId=sm.getLeafId(),editorText:string|undefined;
  if(operation==='fork'){
    const target=sm.getEntry(entryId??'');if(!target)throw new Error('SESSION_INVALID_TARGET');
    if(position==='before'){
      if(target.type!=='message'||target.message.role!=='user')throw new Error('之前分叉只支持用户消息');
      leafId=target.parentId;editorText=typeof target.message.content==='string'?target.message.content:target.message.content.filter(block=>block.type==='text').map(block=>(block as {text:string}).text).join('\n');
    }else leafId=target.id;
  }
  return{leafId,editorText,entries:leafId===null?[]:sm.getBranch(leafId)};
}
