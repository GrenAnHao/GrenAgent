import type { ResourceNavigation, ResourceRef, TaskRef, TaskStatus } from '../../../electron/agentData/operationsContracts';

export const taskKey = (ref: TaskRef) => `${ref.source}:${ref.id}`;
export const taskStatusLabels: Record<TaskStatus, string> = { pending: '等待中', queued: '排队中', running: '运行中', blocked: '受阻', completed: '已完成', failed: '失败', cancelled: '已取消' };
export const isTerminalTask = (status: TaskStatus) => status === 'completed' || status === 'failed' || status === 'cancelled';
export function resourceNavigation(resource: ResourceRef): ResourceNavigation {
  if (resource.type === 'wiki') return { view: 'wiki', kbId: resource.id };
  if (resource.type === 'memory') return { view: 'memory', id: resource.id };
  return { view: 'code', workspace: resource.id };
}

const sensitiveKey = /token|api.?key|secret|credential|authorization|password|cookie|transcript|prompt|raw(?:body|request|response)|requestBody/i;
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'string') return value
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/((?:api[_-]?key|token|secret|password|credential)\s*[=:]\s*)[^\s,;"']+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@');
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sensitiveKey.test(key) ? '[redacted]' : redact(item)]));
}
