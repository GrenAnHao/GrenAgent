export const IPC_CHANNELS = {
  invoke: 'gren:invoke',
  pickDirectory: 'gren:pick-directory',
  openUrl: 'gren:open-url',
  openPath: 'gren:open-path',
  revealItem: 'gren:reveal-item',
  windowMinimize: 'gren:window:minimize',
  windowToggleMaximize: 'gren:window:toggle-maximize',
  windowIsMaximized: 'gren:window:is-maximized',
  windowClose: 'gren:window:close',
  windowSetBackground: 'gren:window:set-background',
  eventPrefix: 'gren:event:',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export interface InvokeRequest {
  command: string;
  args?: Record<string, unknown>;
}

export interface ChannelReference {
  __grenChannelId: string;
}

export interface EventEnvelope<T = unknown> {
  event: string;
  payload: T;
}

export type { Item as ItemDto, Thread as ThreadDto, Turn as TurnDto } from '../app/appServer/types';
export type { PermissionAuthorization, PermissionOperation, PermissionRequest } from '../app/permissionManager';
export type { PluginManifest as PluginManifestDto, PluginStateRecord as PluginStateDto } from '../app/plugin/pluginManager';
export type { WikiManagementApi, WikiLibraryView, WikiSource, WikiPage, WikiVersion } from '../agentData/wikiContracts';
export type { MemoryRecord, ManagedMemoryRecord, MemoryOwner, MemoryFilter, MemoryLevel, MemoryOrigin, MemoryListInput, MemoryPage, MemoryReadInput, MemoryDraft, MemoryCreateInput, MemoryUpdateInput, MemoryConversation, MemoryConversationDetail, MemoryItem } from '../agentData/memoryContracts';
export type { TaskRef, TaskView, TaskStatus, TaskPage, TaskListInput, TaskDetail, TaskRetryPreview, TaskRetryOptions, ResourceRef, ResourceNavigation, AuditQuery, AuditView, AuditPage, AuditExport, DiagnosticItem, DiagnosticReport, WorkbenchOverview } from '../agentData/operationsContracts';

export function isInvokeRequest(value: unknown): value is InvokeRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.command === 'string' && (candidate.args === undefined || isRecord(candidate.args));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
