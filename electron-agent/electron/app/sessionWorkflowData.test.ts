import { describe, expect, it } from 'vitest';
import { SessionManager } from '../../../cli/src/pi-sdk.js';
import { strictSessionJsonl, branchSnapshot, legacyExclusions, editableContent } from './sessionWorkflowData.js';

const assistantMetadata={api:'openai-completions',provider:'fixture',model:'model',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop'};
const user = (content: string, timestamp: number) => ({role:'user',content,timestamp}) as never;
describe('session workflow data — real SDK projection', () => {
  it('strict parser rejects malformed lines, duplicate IDs and dangling references rather than skipping', () => {
    const sm=SessionManager.inMemory('/fixture'); const id=sm.appendMessage(user('M',1));
    const raw=[sm.getHeader(),...sm.getEntries()].map(e=>JSON.stringify(e)).join('\n');
    expect(strictSessionJsonl(raw).entries).toHaveLength(1);
    expect(()=>strictSessionJsonl(raw+'\n{bad')).toThrow(/line 3/i);
    expect(()=>strictSessionJsonl(raw+'\n'+JSON.stringify(sm.getEntry(id)))).toThrow(/duplicate/i);
    expect(()=>strictSessionJsonl(raw.replace('"parentId":null','"parentId":"missing"'))).toThrow(/parent/i);
  });
  it.each(['add','remove'] as const)('snapshot compensates path-external legacy %s without leaking its body', (op) => {
    const sm=SessionManager.inMemory('/fixture'); const m=sm.appendMessage(user('M',1));
    if(op==='remove')sm.appendCustomEntry('context_exclusion',{op:'add',ts:1});
    const b=sm.appendMessage(user('B',2));
    sm.branch(m); sm.appendMessage(user('SECRET_A',3)); sm.appendCustomEntry('context_exclusion',{op,ts:1}); sm.branch(b);
    const before=JSON.stringify(sm.getEntries());
    const result=branchSnapshot(sm);
    expect(JSON.stringify(result)).not.toContain('SECRET_A');
    expect(legacyExclusions(result.entries).has(1)).toBe(op==='add');
    expect(JSON.stringify(sm.getEntries())).toBe(before); expect(sm.getLeafId()).toBe(b);
  });
  it('text replacement retains non-text protocol blocks and restore uses complete original, not null', () => {
    const sm=SessionManager.inMemory('/fixture');
    const content=[{type:'thinking',thinking:'private',thinkingSignature:'sig'},{type:'text',text:'original'},{type:'toolCall',id:'call',name:'read',arguments:{path:'a'}}];
    const id=sm.appendMessage({...assistantMetadata,role:'assistant',content,timestamp:1} as never);
    const replacement=editableContent(sm,id,'summary');
    expect(replacement).toEqual([content[0],{type:'text',text:'summary'},content[2]]);
    sm.appendContextEdit(id,{content:replacement as never});
    expect((sm.buildSessionProjection().messages[0] as {content:unknown}).content).toEqual(replacement);
    const restored=editableContent(sm,id,undefined,true);
    sm.appendContextEdit(id,{content:restored as never});
    expect((sm.buildSessionProjection().messages[0] as {content:unknown}).content).toEqual(content);
    expect(sm.getEntry(id)).toMatchObject({message:{content}});
  });
  it('edits are branch local and reject sibling targets and legacy excluded targets', () => {
    const sm=SessionManager.inMemory('/fixture');const m=sm.appendMessage(user('M',1));
    sm.appendContextEdit(m,{content:'A'});sm.branch(m);const b=sm.appendMessage(user('B',2));
    expect((sm.buildSessionProjection().messages[0] as {content:unknown}).content).toBe('M');
    sm.branch(m);expect(()=>editableContent(sm,b,'x')).toThrow(/current branch/i);
    sm.appendCustomEntry('context_exclusion',{op:'add',ts:1});expect(()=>editableContent(sm,m,'x')).toThrow(/旧版/);
  });
});


it('strict import rejects orphan tool results and invalid content block types',()=>{
 const sm=SessionManager.inMemory('/fixture');sm.appendMessage({role:'toolResult',toolCallId:'missing',toolName:'read',content:[{type:'text',text:'result'}],isError:false,timestamp:1} as never);
 const raw=[sm.getHeader(),...sm.getEntries()].map(e=>JSON.stringify(e)).join('\n');expect(()=>strictSessionJsonl(raw)).toThrow(/tool/i);
 expect(()=>strictSessionJsonl(raw.replace('"type":"text"','"type":"unknown"'))).toThrow(/content/i);
});

it('migrates known v2 data only in the candidate document and rejects future versions',()=>{
 const sm=SessionManager.inMemory('/fixture');sm.appendMessage({role:'user',content:'legacy',timestamp:1});
 const raw=[{...sm.getHeader(),version:2},...sm.getEntries()].map(e=>JSON.stringify(e)).join('\n');
 expect(strictSessionJsonl(raw).header.version).toBe(3);expect(JSON.parse(raw.split('\n')[0]).version).toBe(2);
 expect(()=>strictSessionJsonl(raw.replace('"version":2','"version":900'))).toThrow(/unsupported version/);
});

it('rejects native omission that would orphan an effective tool result',()=>{
 const sm=SessionManager.inMemory('/fixture');const a=sm.appendMessage({...assistantMetadata,role:'assistant',content:[{type:'toolCall',id:'call',name:'read',arguments:{}}],timestamp:1} as never);sm.appendMessage({role:'toolResult',toolCallId:'call',toolName:'read',content:[{type:'text',text:'result'}],isError:false,timestamp:2} as never);sm.appendContextEdit(a,null);
 expect(()=>strictSessionJsonl([sm.getHeader(),...sm.getEntries()].map(e=>JSON.stringify(e)).join('\n'))).toThrow(/effective.*tool/i);
});
