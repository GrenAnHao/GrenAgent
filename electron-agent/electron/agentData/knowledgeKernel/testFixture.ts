import { AgentDataStorage } from '../storage';
import { JobStore } from '../jobStore';
import { KnowledgeBuildStore, hashKnowledgePayload } from './store';
import { DEFAULT_KNOWLEDGE_BUDGETS, type KnowledgeKey, type StageExecutionResult } from '../../../shared/knowledgeKernelContracts';

export const key: KnowledgeKey = { workspaceInstanceId: 'clone1', projectId: 'p', portableProjectId: 'portable', branch: 'main', language: 'en', domain: 'wiki' };
export function fixture(path = ':memory:') { const storage = new AgentDataStorage(path); storage.migrate(); const store = new KnowledgeBuildStore(storage.db, { controllerEpoch: 'epoch' }); return { storage, store }; }
export function create(store: KnowledgeBuildStore, requestId = 'request', patch: Partial<KnowledgeKey> = {}) { return store.createTask({ workspace: '/repo', key: { ...key, ...patch }, request: { version: 1, requestId, projectId: 'p', domain: patch.domain ?? 'wiki', language: patch.language ?? 'en', intent: 'generate', confirmExternal: true, expectedModelIdentity: 'model', expectedPlanToken: 'plan' }, pipelineConfigHash: 'pipeline' }); }
export function result(taskId: string, fence: StageExecutionResult['fence'], patch: Partial<StageExecutionResult> = {}): StageExecutionResult { const payload = { markdown: '# Verified' }; return { version: 1, taskId, fence, phase: 'generate', itemId: 'page', stageAttempt: 1, sequence: 1, inputHash: 'input', outputHash: hashKnowledgePayload(payload), payload, disposition: 'prepared', evidence: [], dependencies: [], ...patch }; }



