import type { Api, AssistantMessage, Model, ThinkingLevel, TranscriptContext } from '@earendil-works/pi-ai';
import { z } from 'zod';

export type KnowledgeDomain = 'wiki' | 'cards';
export type KnowledgeIntent = 'generate' | 'update' | 'regenerate' | 'repair';
export const KNOWLEDGE_PHASES = ['prepare', 'change_analysis', 'readme', 'overview', 'plan', 'catalogue', 'generate', 'relations', 'validate', 'publish'] as const;
export type KnowledgePhase = typeof KNOWLEDGE_PHASES[number];
export interface KnowledgeKey { workspaceInstanceId: string; projectId: string; portableProjectId: string; branch: string; language: string; domain: KnowledgeDomain }
export interface ExecutionFence { ledgerId: string; controllerEpoch: string; ownerId: string; generation: number }
export interface KnowledgeBudgets {
  version: 1;
  unit: { maxModelRequests: number; maxToolCalls: number; maxAttempts: number; maxOutputTokens: number; maxTotalTokens: number; maxFileBytes: number; maxReadBytes: number; maxReadLines: number; maxResultBytes: number; maxSearchMatches: number; maxDirectoryEntries: number; modelTimeoutMs: number; activeTimeMs: number };
  run: { maxItems: number; maxDepth: number; maxModelRequests: number; maxTotalTokens: number };
}
export const KNOWLEDGE_STAGE_KINDS = ['overview', 'plan', 'catalogue', 'page', 'module-card', 'repository-card', 'relations'] as const;
export type KnowledgeStageKind = typeof KNOWLEDGE_STAGE_KINDS[number];
export interface KnowledgeExecutionPolicyV2 { version: 2; catalogueConcurrency: number; pageConcurrency: number; maxCatalogueNodes: number; profiles: Record<KnowledgeStageKind, KnowledgeBudgets['unit']> }
export const DEFAULT_KNOWLEDGE_BUDGETS: Readonly<KnowledgeBudgets> = Object.freeze({ version: 1, unit: { maxModelRequests: 20, maxToolCalls: 60, maxAttempts: 2, maxOutputTokens: 8192, maxTotalTokens: 300000, maxFileBytes: 262144, maxReadBytes: 2097152, maxReadLines: 400, maxResultBytes: 32768, maxSearchMatches: 100, maxDirectoryEntries: 200, modelTimeoutMs: 120000, activeTimeMs: 600000 }, run: { maxItems: 500, maxDepth: 6, maxModelRequests: 1000, maxTotalTokens: 5000000 } });
/**
 * Tokens charged against a knowledge budget. An Agent tool loop resends the whole transcript every
 * turn, so most input is a provider cache hit; cache reads count at a tenth, which tracks typical
 * pricing instead of billing the same context again on every turn.
 */
export const CACHE_READ_BUDGET_DIVISOR = 10;
export function knowledgeBudgetTokens(usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): number {
  return usage.input + usage.output + (usage.cacheWrite ?? 0) + Math.ceil((usage.cacheRead ?? 0) / CACHE_READ_BUDGET_DIVISOR);
}
/** Upper-bound token estimate for a transcript before the provider reports usage (UTF-8 bytes per token is at least ~3). */
export const TRANSCRIPT_BYTES_PER_TOKEN = 3;
export const KNOWLEDGE_ITEM_MAX_BYTES = 512 * 1024;
export const KNOWLEDGE_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const KNOWLEDGE_TIME_SLICE_MAX_MS = 5000;
export interface KnowledgeTaskMetadata {
  version: 1; key: KnowledgeKey; intent: KnowledgeIntent; revision: number; phase: KnowledgePhase;
  requestId?: string; currentItem?: string; sourceSnapshotId?: string; modelIdentity?: string; pipelineConfigHash: string; budgets: KnowledgeBudgets; executionPolicy?: KnowledgeExecutionPolicyV2;
  planHash?: string; resumePolicy: 'auto' | 'manual' | 'never'; pauseCause?: 'user' | 'application_exit'; fence?: ExecutionFence;
  counts: { planned: number; prepared: number; failed: number; blocked: number; published: number };
  outcome?: 'complete' | 'partial'; publication?: { id: string; claimId: string; intentHash: string; state: 'claimed' | 'prepared' | 'files_committed' };
  control?: { requestId: string; action: 'pause' | 'cancel'; cause: 'user' | 'application_exit'; requestedAt: number };
  error?: { code: string; message: string; retriable: boolean };
}
export interface StartKnowledgeTask { version: 1; requestId: string; projectId: string; domain: KnowledgeDomain; language: string; intent: KnowledgeIntent; confirmExternal: true; expectedModelIdentity: string; expectedPlanToken: string; retryOf?: string }
export interface KnowledgeActionInput { version: 1; requestId: string; taskId: string; expectedRevision: number; action: 'pause' | 'resume' | 'cancel' | 'repair' | 'reanalyse'; fence?: ExecutionFence }
export type PublicModelDescriptor = Pick<Model<Api>, 'id' | 'name' | 'api' | 'provider' | 'reasoning' | 'input' | 'contextWindow' | 'maxTokens' | 'cost'>;
export interface KnowledgeModelBinding { bindingId: string; expectedModel: string; expectedConfiguration: string; model: PublicModelDescriptor }
export interface KnowledgeExecutionScope { taskId: string; fence: ExecutionFence; phase: KnowledgePhase; itemId: string; attempt: number }
export function knowledgeExecutionKey(scope: KnowledgeExecutionScope): string { return JSON.stringify([scope.taskId, scope.fence.ledgerId, scope.fence.controllerEpoch, scope.fence.ownerId, scope.fence.generation, scope.phase, scope.itemId, scope.attempt]); }
export interface KnowledgeMessageInput { controllerEpoch: string; requestId: string; taskId: string; fence: ExecutionFence; phase: KnowledgePhase; itemId: string; attempt: number; bindingId: string; transcript: TranscriptContext; options: { maxTokens: number; reasoning?: ThinkingLevel } }
export interface KnowledgeMessagePort { bind(taskId: string): Promise<KnowledgeModelBinding>; request(input: KnowledgeMessageInput, signal?: AbortSignal): Promise<AssistantMessage> }
export interface KnowledgeEvidence { path: string; hash?: string; startLine?: number; endLine?: number; kind?: 'read' | 'search' | 'directory'; scope?: string }
export interface KnowledgeDependency { phase: KnowledgePhase; itemId: string; outputHash: string }
export interface KnowledgeUsage { modelRequests?: number; toolCalls?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number; readBytes?: number; resultBytes?: number; activeTimeMs?: number; unknown?: boolean }
export interface StageArtifact { version: 1; phase: KnowledgePhase; itemId: string; inputHash: string; outputHash: string; payload: unknown; evidence: KnowledgeEvidence[]; dependencies: KnowledgeDependency[] }
export interface StageExecutionRequest { version: 1; taskId: string; key: KnowledgeKey; fence: ExecutionFence; phase: KnowledgePhase; itemId: string; attempt: number; inputHash: string; sourceSnapshotId: string; binding: KnowledgeModelBinding; budget: KnowledgeBudgets; input?: unknown }
export interface StageExecutionResult extends StageArtifact { taskId: string; fence: ExecutionFence; stageAttempt: number; sequence: number; disposition: 'prepared' | 'failed' | 'blocked'; usage?: KnowledgeUsage; error?: { code: string; message: string; retriable: boolean } }
export interface StageExecutionPorts { execute(request: StageExecutionRequest, signal?: AbortSignal): Promise<StageExecutionResult> }
export interface PublishClaim { version: 1; taskId: string; claimId: string; publicationId: string; fence: ExecutionFence; expectedRevision: number; intentHash: string; outputSetHash: string }
export interface PublishReceipt { version: 1; taskId: string; claimId: string; publicationId: string; ledgerId: string; generation: number; intentHash: string; outputSetHash: string }
export type KnowledgeRunState = 'queued' | 'running' | 'recovering' | 'pause_requested' | 'paused' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export interface KnowledgeCapabilities { pause: boolean; resume: boolean; cancel: boolean; repair: boolean; reanalyse: boolean }
export interface RepoWikiKnowledgeSnapshot {
  version: 1; key: KnowledgeKey;
  content: { state: 'empty' | 'available' | 'current' | 'stale' | 'partial'; publishedCount: number; preparedCount: number; expectedCount: number; baselineId?: string; checkedSnapshotId?: string; updatedAt?: number };
  run: { taskId: string; revision: number; phase: KnowledgePhase; state: KnowledgeRunState; counts: KnowledgeTaskMetadata['counts']; capabilities: KnowledgeCapabilities; currentItem?: string; activeItems?: Array<{ phase: KnowledgePhase; itemId: string; title: string }>; error?: KnowledgeTaskMetadata['error']; outcome?: 'complete' | 'partial'; updatedAt?: number } | null;
  action: { state: 'idle' | 'submitting'; kind?: KnowledgeActionInput['action'] | KnowledgeIntent; requestId?: string };
  admission: { state: 'ready' | 'preparing' | 'blocked'; reasonCode?: string; message?: string; modelIdentity?: string; modelDisplayName?: string; planToken?: string };
}

const text = z.string().min(1).max(1000);
const integer = z.number().int().nonnegative().safe();
const phase = z.enum(KNOWLEDGE_PHASES);
const intent = z.enum(['generate', 'update', 'regenerate', 'repair']);
const domain = z.enum(['wiki', 'cards']);
const language = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,19}$/);
export const knowledgeKeySchema = z.object({ workspaceInstanceId: text, projectId: text, portableProjectId: text, branch: text.refine(v => /^detached:[a-f0-9]{12}$/.test(v) || v !== '.' && !v.includes('..') && !/[\\\x00-\x20~^:?*\[]/.test(v) && !v.startsWith('/') && !v.endsWith('/')), language, domain }).strict();
export const executionFenceSchema = z.object({ ledgerId: text, controllerEpoch: text, ownerId: text, generation: integer.positive() }).strict();
const budgetsSchema = z.object({ version: z.literal(1), unit: z.object(Object.fromEntries(Object.keys(DEFAULT_KNOWLEDGE_BUDGETS.unit).map(k => [k, integer.positive()]))), run: z.object({ maxItems: integer.positive(), maxDepth: integer.positive(), maxModelRequests: integer.positive(), maxTotalTokens: integer.positive() }) });
export const knowledgeExecutionPolicySchema = z.object({ version: z.literal(2), catalogueConcurrency: integer.positive(), pageConcurrency: integer.positive(), maxCatalogueNodes: integer.positive(), profiles: z.object(Object.fromEntries(KNOWLEDGE_STAGE_KINDS.map(k => [k, budgetsSchema.shape.unit]))).strict() }).strict();
const errorSchema = z.object({ code: text, message: text, retriable: z.boolean() }).strict();
export const knowledgeTaskMetadataSchema = z.object({ version: z.literal(1), key: knowledgeKeySchema, intent, revision: integer, phase, requestId: text.optional(), currentItem: text.optional(), sourceSnapshotId: text.optional(), modelIdentity: text.optional(), pipelineConfigHash: text, budgets: budgetsSchema, executionPolicy: knowledgeExecutionPolicySchema.optional(), planHash: text.optional(), resumePolicy: z.enum(['auto', 'manual', 'never']), pauseCause: z.enum(['user', 'application_exit']).optional(), fence: executionFenceSchema.optional(), counts: z.object({ planned: integer, prepared: integer, failed: integer, blocked: integer, published: integer }).strict(), outcome: z.enum(['complete', 'partial']).optional(), publication: z.object({ id: text, claimId: text, intentHash: text, state: z.enum(['claimed', 'prepared', 'files_committed']) }).strict().optional(), control: z.object({ requestId: text, action: z.enum(['pause', 'cancel']), cause: z.enum(['user', 'application_exit']), requestedAt: integer }).strict().optional(), error: errorSchema.optional() }).strict();
export function parseKnowledgeTaskMetadata(value: unknown): KnowledgeTaskMetadata { return knowledgeTaskMetadataSchema.parse(value) as KnowledgeTaskMetadata; }
export function parseStartKnowledgeTask(value: unknown): StartKnowledgeTask { return z.object({ version: z.literal(1), requestId: text, projectId: text, domain, language, intent, confirmExternal: z.literal(true), expectedModelIdentity: text, expectedPlanToken: text, retryOf: text.optional() }).strict().parse(value); }
export function parseKnowledgeActionInput(value: unknown): KnowledgeActionInput { return z.object({ version: z.literal(1), requestId: text, taskId: text, expectedRevision: integer, action: z.enum(['pause', 'resume', 'cancel', 'repair', 'reanalyse']), fence: executionFenceSchema.optional() }).strict().parse(value); }
export function assertKnowledgePayloadSize(value: unknown, max = KNOWLEDGE_ITEM_MAX_BYTES): void { const encoded = JSON.stringify(value); if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > max) throw new Error('PAYLOAD_TOO_LARGE'); }
export function parseStageExecutionResult(value: unknown): StageExecutionResult {
  const row = z.object({ version: z.literal(1), taskId: text, fence: executionFenceSchema, phase, itemId: text, stageAttempt: integer.positive(), sequence: integer, inputHash: text, outputHash: text, payload: z.unknown(), disposition: z.enum(['prepared', 'failed', 'blocked']), evidence: z.array(z.object({ path: text, hash: text.optional(), startLine: integer.optional(), endLine: integer.optional(), kind: z.enum(['read', 'search', 'directory']).optional(), scope: text.optional() }).strict()), dependencies: z.array(z.object({ phase, itemId: text, outputHash: text }).strict()), usage: z.object({ modelRequests: integer.optional(), toolCalls: integer.optional(), inputTokens: integer.optional(), outputTokens: integer.optional(), totalTokens: integer.optional(), readBytes: integer.optional(), resultBytes: integer.optional(), activeTimeMs: integer.optional(), unknown: z.boolean().optional() }).strict().optional(), error: errorSchema.optional() }).strict().parse(value);
  assertKnowledgePayloadSize(row.payload); return { ...row, payload: row.payload };
}


