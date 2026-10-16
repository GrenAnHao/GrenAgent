// 在真实 agent-data.db 的副本上跑真实 AgentDataRuntime + TCP 客户端，打印 M0 埋点取到的样本。
// 用法（仓库根目录）：pnpm exec tsx .agents/evidence/2026-10-16-agentdata-sync-timing-diag/real-db-run.mts <db 副本路径>
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AgentDataRuntime } from '../../../electron-agent/electron/agentData/runtime';
import { AgentDataClient } from '../../../electron-agent/electron/agentData/client';
import { agentDataTiming } from '../../../electron-agent/electron/agentData/methodTiming';

const dataPath = process.argv[2];
const probe = new DatabaseSync(dataPath, { readOnly: true });
const big = probe.prepare('select thread_id id, count(*) c, sum(length(payload)) b from items group by thread_id order by b desc limit 1').get() as { id: string; c: number; b: number };
const turn = probe.prepare('select id from turns where thread_id=? limit 1').get(big.id) as { id: string };
const user = (probe.prepare('select user_id from memories limit 1').get() as { user_id: string } | undefined)?.user_id ?? 'local';
probe.close();

const runtime = new AgentDataRuntime({ dataPath });
const client = new AgentDataClient(await runtime.start(), { timeoutMs: 30_000, closeOnTimeout: false });
agentDataTiming.drain();
for (let i = 0; i < 30; i += 1) await client.request('item.upsert', { id: randomUUID(), threadId: big.id, turnId: turn.id, type: 'tool_result', status: 'completed', payload: { text: 'x'.repeat(7000) } });
for (const query of ['agent', 'error', '代码']) await client.request('memory.conversations.search', { userId: user, query, limit: 20, includeOtherProjects: true });
await runtime.requestAdmin('admin.audit.query', { limit: 50 });
await runtime.requestAdmin('memory.conversations.list', { userId: user, filter: { scope: 'all' }, limit: 50 });
const read = await client.request('thread.read', { id: big.id }).then(() => 'ok', (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`);
const sample = agentDataTiming.drain();
console.log(JSON.stringify({ largestThread: { items: big.c, payloadBytes: big.b }, threadReadOverTcp: read, sample }, null, 2));
await client.close();
runtime.close();
await runtime.waitClosed();
