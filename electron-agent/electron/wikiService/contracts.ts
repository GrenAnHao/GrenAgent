import type { WikiSessionEvent } from './sessionRuntime';
export const WIKI_ENGINE = 'qoder-wiki-local-v1' as const;
export type WikiAction = 'full' | 'update' | 'sync' | 'repair' | 'regenerate';
export type WikiState = 'queued' | 'running' | 'pausing' | 'cancelling' | 'paused' | 'cancelled' | 'failed' | 'completed';
export interface WikiSpendingPolicy { maxModelRequests?: number; maxTotalTokens?: number }
export interface WikiStartInput {
  requestId: string; projectId: string; repositoryRoot: string; branch: string; locale: string; action: WikiAction; targetCommit: string;
  engine: typeof WIKI_ENGINE; templateVersion: string; model: Record<string, unknown>; author: Record<string, unknown>;
  plan: Record<string, unknown>; spendingPolicy: WikiSpendingPolicy; effectiveProfile: Record<string, unknown>; authorization: { confirmed: true }; parentOperationId?: string; expectedRevision?: number;
}
export interface WikiOperation extends WikiStartInput { id: string; state: WikiState; revision: number; runId?: string; error?: string; publicationId?: string }
export interface WikiFence { operationId: string; owner: string; generation: number }
export interface WikiCheckpoint { stage: string; itemId: string; disposition: 'done' | 'failed'; raw: string; parsed: unknown; attempt?: number; error?: string }
export interface WikiUsage { requestId: string; state: 'dispatched' | 'actual' | 'unknown'; reservationTokens?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number }
export interface WikiManifest { catalogue: Array<{ id: string; [key: string]: unknown }>; requiredStages: string[]; pages: Array<{ id: string; disposition: 'done' | 'failed' }>; deletedPageIds: string[]; baseline: string; mode: 'full' | 'incremental'; expectedPriorPublicationId: string | null }
export interface WikiPublication { id: string; operationId: string; branch: string; locale: string; baseline: string; sourceManifest: Array<{ path: string; hash: string }>; sourceScope: { include: string[]; exclude: string[] }; catalogue: WikiManifest['catalogue']; pages: Record<string, unknown>; requiredPageIds: string[]; coverage: { partial: boolean; planned: number; published: number; readable: number; failed: string[] }; manifest: WikiManifest }
export interface WikiRunContext { signal: AbortSignal; checkpoints(): WikiCheckpoint[]; checkpointHistory(): WikiCheckpoint[]; usageRecords(): WikiUsage[]; aggregateUsageRecords(): WikiUsage[]; published(): WikiPublication | undefined; publication(id: string): WikiPublication | undefined; event(value: WikiSessionEvent): void; stage(stage: string, detail?: unknown): void; checkpoint(value: WikiCheckpoint): void; usage(value: WikiUsage): void; publish(manifest: WikiManifest): WikiPublication }
export interface WikiAdmission { acquire(operation: WikiOperation, signal: AbortSignal): Promise<{ release(): Promise<void> | void }> }
export interface WikiServicePorts { admission: WikiAdmission; executeOperation(operation: WikiOperation, context: WikiRunContext): Promise<void>; leaseMs?: number }






