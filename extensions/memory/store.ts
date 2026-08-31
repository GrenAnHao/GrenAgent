export interface MemoryScope { userId: string; workspace: string; sessionId?: string }
export interface MemoryItem { id: string; level: number; content: string; source?: string }
export interface MemoryStoreClient { request<T>(method: string, params: Record<string, unknown>): Promise<T> }
export function scopeFromContext(ctx: { cwd: string; sessionManager: { getSessionId(): string } }): MemoryScope { return { userId: 'local', workspace: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }; }
