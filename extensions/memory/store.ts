import { projectCwd } from "../_shared/session-cwd.js";
export interface MemoryScope { userId: string; workspace: string; projectId?: string; sessionId?: string; includeOtherProjects?: boolean }
export interface MemoryItem { id: string; level: number; content: string; source?: string }
export interface MemoryStoreClient { request<T>(method: string, params: Record<string, unknown>): Promise<T> }
// 记忆按项目归属：切到 worktree 后仍按会话的原始目录。
export function scopeFromContext(ctx: { cwd: string; sessionManager: { getSessionId(): string; getCwd?: () => string } }): MemoryScope { const project = projectCwd(ctx); return { userId: 'local', workspace: project, projectId: project, sessionId: ctx.sessionManager.getSessionId() }; }
