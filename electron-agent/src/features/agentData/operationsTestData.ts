import type { AuditView, DiagnosticReport, TaskDetail, TaskView } from '../../../electron/agentData/operationsContracts';

export const task: TaskView = {
  ref: { source: 'user', id: 'same-id' }, key: 'user:same-id', kind: 'wiki.ingest', label: '生成知识页面',
  status: 'failed', resource: { type: 'wiki', id: 'kb-a' }, resourceName: '团队知识库', workspace: 'D:/alpha',
  cancellationRequested: false, createdAt: 1, updatedAt: 2, error: '来源读取失败',
  capabilities: { cancel: false, retry: true, remove: true },
};
export const systemTask: TaskView = {
  ...task, ref: { source: 'system', id: 'same-id' }, key: 'system:same-id', label: '后台维护',
  kind: 'wiki.extract', status: 'running', error: undefined,
  capabilities: { cancel: false, retry: false, remove: false },
};
export const taskDetail: TaskDetail = { ...task, attempts: 2, processed: 1, total: 3, events: [{ id: 'event-1', action: 'failed', message: '处理停止', createdAt: 2 }] };
export const auditEvent: AuditView = {
  id: 'audit-1', action: 'wiki.ingest.failed', summary: '页面生成失败', resource: task.resource,
  resourceName: task.resourceName, createdAt: 1000,
  detail: { apiKey: 'secret-value', nested: { authorization: 'Bearer abc', token: 'token-value' }, message: 'Authorization: Bearer secret-bearer', resourceId: 'kb-a' },
};
export const report: DiagnosticReport = { checkedAt: 2000, items: [
  { id: 'wiki:kb-a:manifest', resource: task.resource, state: 'action_required', checkedAt: 2000, message: '页面清单需要重建', action: 'reindex_wiki' },
  { id: 'codegraph:cli', state: 'unchecked', checkedAt: 2000, message: 'CodeGraph CLI 尚未配置', action: 'configure_codegraph' },
] };
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
