import { posix, win32 } from 'node:path';
import type { ResourceRef } from './operationsContracts';

type OperationText = 'identifier' | 'model' | 'project' | 'pagePath' | 'text';
const credential = /\b(?:bearer|basic)\s+\S+|\b(?:api[_ -]?key|access[_ -]?token|token|secret|credential|password|authorization)["']?\s*[:=]\s*\S+/i;

/** Validate typed operations fields; this does not attempt to detect secrets in arbitrary prose. */
export function operationText(value: unknown, type: OperationText): string | undefined {
  if (typeof value !== 'string' || !value || value.length > (type === 'identifier' || type === 'model' ? 500 : 2048)) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value) || credential.test(value)) return type === 'text' ? '[redacted]' : undefined;
  if (type === 'text') return value;
  if (type === 'project') return !value.includes('://') && (posix.isAbsolute(value) || win32.isAbsolute(value)) ? value : undefined;
  if (type === 'pagePath') {
    if (posix.isAbsolute(value) || win32.isAbsolute(value)) return undefined;
    try { const parsed: unknown = JSON.parse(value); if (parsed && typeof parsed === 'object') return undefined; } catch { /* A normal path is not JSON. */ }
    const parts = value.replace(/\\/g, '/').split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\p{Cc}]/u.test(part)
      || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return undefined;
    return value;
  }
  return !value.includes('://') && /^[\p{L}\p{N}_.:@/+\-]+$/u.test(value) ? value : undefined;
}

export function operationResource(value: unknown): ResourceRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { type, id } = value as Record<string, unknown>;
  if (type !== 'wiki' && type !== 'project' && type !== 'memory') return undefined;
  const safeId = operationText(id, type === 'project' ? 'project' : 'identifier');
  return safeId ? { type, id: safeId } : undefined;
}
