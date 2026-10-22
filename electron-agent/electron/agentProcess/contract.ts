/**
 * 主进程与 agent-host 子进程之间的方法表。两边都从这里取方法名，
 * 子进程的处理表按 AgentMethod 建，漏一个或多一个都过不了类型检查。
 * 本文件只放类型和常量，主进程引入它不会牵出任何扩展模块。
 */
import type { Turn } from '../app/appServer/types';
import type { PermissionAuthorization, PermissionOperation } from '../app/permissionManager';

/** 主进程 → 子进程。 */
export const AGENT_METHODS = [
  'pi.openWorkspace',
  'pi.listRunningTurns',
  'pi.warmWorkspace',
  'pi.closeWorkspace',
  'pi.respondUi',
  'pi.send',
  'pi.permissionProfile',
  'pi.refreshModelRegistry',
  'pi.enqueueTurn',
  'pi.releaseSessions',
  'pi.ownsSession',
  'pi.activeModel',
  'subagent.list',
  'subagent.transcript',
  'subagent.sessionMessages',
  'subagent.catalog',
  'subagent.catalogRowSample',
  'subagent.promptChild',
  'subagent.interruptChild',
  'subagent.cancel',
  'jobs.snapshot',
  'jobs.kill',
  'mcp.hotReload',
  'mcp.reload',
  'mcp.probe',
  'mcp.workspaceForCwd',
  'controlPlane.release',
  'controlPlane.releaseChildForDelete',
  'resources.reload',
  'extensions.catalog',
  'usage.report',
  'usage.reconcile',
] as const;
export type AgentMethod = typeof AGENT_METHODS[number];

/** 子进程 → 主进程。 */
export const HOST_METHODS = [
  'host.resolveWorkspace',
  'host.agentDataEndpoint',
  'host.mcpRuntime',
  'host.allowedPluginIds',
  'host.authorize',
  'host.mergeRuntimeSettings',
  'host.thread.createThread',
  'host.thread.createTurn',
  'host.thread.updateTurn',
  'host.thread.upsertItem',
] as const;
export type HostMethod = typeof HOST_METHODS[number];

/** 子进程发给主进程、由主进程原样推给所有窗口的事件。 */
export const BROADCAST_CHANNEL = 'broadcast';
/** 子进程每 10 秒报一次内存与事件循环延迟，主进程写进 runtime-diag.jsonl。 */
export const DIAG_CHANNEL = 'host.diag';
export interface BroadcastPayload {
  channel: string;
  payload: unknown;
}

export interface McpServerEntry {
  name: string;
  config: Record<string, unknown>;
}

export interface ThreadStorePort {
  createThread(input: { id: string; projectId: string; workspace: string; title?: string; sessionId?: string }): Promise<unknown>;
  createTurn(input: { id: string; threadId: string; input: string; permissionProfile: string; mode?: Turn['mode']; sessionId?: string }): Promise<unknown>;
  updateTurn(id: string, patch: Partial<Pick<Turn, 'status' | 'startedAt' | 'completedAt' | 'error'>>): Promise<unknown>;
  upsertItem(item: { id: string; threadId: string; turnId: string; type: 'assistant_message' | 'tool_call'; status: 'started' | 'streaming' | 'completed' | 'failed'; payload: unknown }): Promise<unknown>;
}

/** 子进程用到的主进程能力。 */
export interface HostApi {
  resolveWorkspace(path: string): Promise<string>;
  agentDataEndpoint(cwd: string): Promise<string | undefined>;
  mcpRuntime(workspace: string): Promise<McpServerEntry[]>;
  allowedPluginIds(): Promise<string[]>;
  authorize(operation: PermissionOperation, profile: string): Promise<PermissionAuthorization>;
  mergeRuntimeSettings(patch: Record<string, string>): Promise<void>;
  thread: ThreadStorePort;
}

export interface ActiveModel {
  provider: string;
  modelId: string;
}

export interface ExtensionCatalogEntry {
  name: string;
  manifest?: { id: string };
}
