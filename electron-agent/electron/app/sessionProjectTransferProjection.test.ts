import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { SessionManager } from '../../../cli/src/pi-sdk.js';
import { buildTransferredSession } from './sessionProjectTransferHistory.js';
import { workflowHistoryMessages } from './sessionWorkflowData.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, {recursive:true,force:true}))); });
const meta = {api:'openai-completions',provider:'fixture',model:'fixture',stopReason:'toolUse',
  usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
it('projects original reference roots from full-log transfer facts even when the selected branch excludes markers', async () => {
  const root = await mkdtemp(join(tmpdir(),'gren-transfer-projection-')); roots.push(root);
  const source = join(root,'source'); const target = join(root,'target');
  await Promise.all([mkdir(source),mkdir(target)]);
  const sm = SessionManager.inMemory(source);
  sm.appendMessage({role:'user',content:'original',timestamp:1});
  sm.appendMessage({...meta,role:'assistant',content:[{type:'toolCall',id:'old-call',name:'write',arguments:{path:'same.md',content:'old'}}],timestamp:2} as never);
  const leaf = sm.appendMessage({role:'toolResult',toolCallId:'old-call',toolName:'write',content:[{type:'text',text:'saved'}],details:{path:'same.md'},isError:false,timestamp:3} as never);
  const raw = `${[sm.getHeader(),...sm.getEntries()].map(row=>JSON.stringify(row)).join('\n')}\n`;
  const moved = buildTransferredSession(raw,{operationId:'33333333-3333-4333-8333-333333333333',fromWorkspace:source,toWorkspace:target,leafId:leaf,now:1});
  const path = join(root,'session.jsonl'); await writeFile(path,moved.raw);
  const opened = SessionManager.open(path); opened.branch(leaf);
  const before = workflowHistoryMessages(opened).find(message=>message.role==='toolResult')!;
  expect(before.sourceCwd).toBe(source);
  expect(before.sourceRefs).toMatchObject({path:source});
  expect(before.entryId).toBe(leaf);
  opened.appendMessage({...meta,role:'assistant',content:[{type:'toolCall',id:'new-call',name:'write',arguments:{path:'same.md',content:'new'}}],timestamp:4} as never);
  opened.appendMessage({role:'toolResult',toolCallId:'new-call',toolName:'write',content:[{type:'text',text:'saved'}],details:{path:'same.md'},isError:false,timestamp:5} as never);
  const after = workflowHistoryMessages(opened).filter(message=>message.role==='toolResult');
  expect(after.map(message=>message.sourceCwd)).toEqual([source,target]);
  expect(after[1].sourceRefs).toMatchObject({path:target});
});
