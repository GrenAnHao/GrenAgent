export type MemoryOwner = { scope: 'global' } | { scope: 'project'; projectId: string };
export type MemoryFilter = { scope: 'all' } | MemoryOwner;
export type MemoryLevel = 0 | 1 | 2 | 3;
export type MemoryOrigin = 'automatic' | 'manual';
export interface MemoryRecord {
  id: string; level: MemoryLevel; content: string; source?: string;
  sourceProjectId?: string; scope?: 'global' | 'project';
  createdAt: number; updatedAt: number;
}
export interface ManagedMemoryRecord extends MemoryRecord {
  scope: 'global' | 'project';
  sourceSessionId?: string; sourceWorkspace?: string;
  revision: number;
  origin: MemoryOrigin; contentHash: string;
}
export interface MemoryListInput {
  userId: string; filter: MemoryFilter; query?: string; level?: MemoryLevel;
  cursor?: string; limit?: number;
}
export interface MemoryPage<T> { items: T[]; nextCursor?: string }
export interface MemoryReadInput { userId: string; id: string }
export interface MemoryDraft {
  content: string; level: MemoryLevel; owner: MemoryOwner; source?: string;
}
export interface MemoryCreateInput { userId: string; draft: MemoryDraft }
export interface MemoryUpdateInput extends MemoryCreateInput {
  id: string; expectedRevision: number;
}
export interface MemoryConversation {
  id: string; source: string; sourceSessionId?: string; workspace: string;
  sourceProjectId: string; snippet: string; updatedAt: number;
}
export interface MemoryConversationDetail extends MemoryConversation { transcript: string }
export type MemoryItem =
  | { kind: 'memory'; record: ManagedMemoryRecord }
  | { kind: 'conversation'; record: MemoryConversation };
