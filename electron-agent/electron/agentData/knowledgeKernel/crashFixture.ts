import { writeFileSync } from 'node:fs';
import { AgentDataStorage } from '../storage';
import { KnowledgeBuildStore } from './store';
import { DEFAULT_KNOWLEDGE_BUDGETS } from '../../../shared/knowledgeKernelContracts';
const TOOLS = DEFAULT_KNOWLEDGE_BUDGETS.unit.maxToolCalls;
const [path, ready] = process.argv.slice(2);
const storage = new AgentDataStorage(path); storage.migrate();
const store = new KnowledgeBuildStore(storage.db, { controllerEpoch: 'before-crash' });
const job = store.createTask({ workspace: '/repo', key: { workspaceInstanceId: 'clone', projectId: 'p', portableProjectId: 'p', branch: 'main', language: 'en', domain: 'wiki' }, request: { version: 1, requestId: 'r', projectId: 'p', domain: 'wiki', language: 'en', intent: 'generate', confirmExternal: true, expectedModelIdentity: 'm', expectedPlanToken: 'plan' }, pipelineConfigHash: 'p' });
const fence = store.claim('scope', job.id, 'worker', 0);
store.beginAttempt(job.id, 'generate', 'page', fence, 'hash'); store.beginAttempt(job.id, 'generate', 'page', fence, 'hash');
for (let n = 0; n < TOOLS; n++) { const requestId = `tool-${n}`; store.reserveExecutionBudget({ requestId, taskId: job.id, phase: 'generate', itemId: 'page', attempt: 2, fence, kind: 'tool', reserved: { readBytes: Math.floor(DEFAULT_KNOWLEDGE_BUDGETS.unit.maxReadBytes / TOOLS) } }); store.markExecutionDispatched(requestId); }
store.reserveExecutionBudget({ requestId: 'last-read', taskId: job.id, phase: 'generate', itemId: 'page', attempt: 2, fence, kind: 'model', reserved: { readBytes: 32, totalTokens: 1024 } }); store.markExecutionDispatched('last-read');
for (let n = 0; n < 120; n++) store.reserveExecutionBudget({ requestId: `time-${n}`, taskId: job.id, phase: 'generate', itemId: 'page', attempt: 2, fence, kind: 'time', reserved: { activeTimeMs: 5000 } });
writeFileSync(ready, JSON.stringify({ taskId: job.id }));
setInterval(() => {}, 1000);
