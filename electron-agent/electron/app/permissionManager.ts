import { appendFile, mkdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppEvent } from './appServer/types';

export type PermissionDecision = 'allow' | 'deny' | 'ask';
export type PermissionResolution = 'allow' | 'deny';
export type PermissionProfileName = 'readonly' | 'workspace' | 'interactive' | 'automation' | 'unrestricted' | string;
export interface PermissionOperation { kind: string; workspace?: string; path?: string; [key: string]: unknown; }
export interface PermissionProvider { name: string; evaluate(operation: PermissionOperation, profile: PermissionProfileName): PermissionDecision | Promise<PermissionDecision>; }
export interface PermissionRequest { id: string; operation: PermissionOperation; profile: PermissionProfileName; createdAt: number; status: 'blocked' | 'resolved'; resolution?: PermissionResolution; }
export interface PermissionAuthorization { status: 'allowed' | 'denied' | 'blocked'; decision: PermissionDecision; request?: PermissionRequest; }
export interface PermissionManagerOptions { dataDir: string; providers?: PermissionProvider[]; publish?: (event: Omit<AppEvent, 'sequence'>) => void; resolveProfile?: (operation: PermissionOperation, requested: PermissionProfileName) => PermissionProfileName; now?: () => number; }

export class PermissionManager {
  private readonly requests = new Map<string, PermissionRequest>();
  private readonly now: () => number;
  constructor(private readonly options: PermissionManagerOptions) { this.now = options.now ?? Date.now; }

  async evaluate(operation: PermissionOperation, profile: PermissionProfileName): Promise<PermissionDecision> {
    const decisions: PermissionDecision[] = [this.builtin(operation, profile)];
    for (const provider of this.options.providers ?? []) decisions.push(await provider.evaluate(operation, profile));
    if (decisions.includes('deny')) return 'deny';
    if (decisions.includes('ask')) return 'ask';
    return 'allow';
  }

  async authorize(operation: PermissionOperation, profile: PermissionProfileName): Promise<PermissionAuthorization> {
    const effectiveProfile = this.options.resolveProfile?.(operation, profile) ?? profile;
    const decision = await this.evaluate(operation, effectiveProfile);
    if (decision === 'allow') return { status: 'allowed', decision };
    if (decision === 'deny') return { status: 'denied', decision };
    const request: PermissionRequest = { id: randomUUID(), operation, profile: effectiveProfile, createdAt: this.now(), status: 'blocked' };
    this.requests.set(request.id, request);
    await this.audit({ type: 'requested', requestId: request.id, operation, profile: effectiveProfile, createdAt: request.createdAt });
    this.publish('permission.requested', { request });
    return { status: 'blocked', decision, request };
  }

  async resolve(id: string, resolution: PermissionResolution): Promise<PermissionRequest> {
    const request = this.requests.get(id);
    if (!request) throw new Error(`permission request not found: ${id}`);
    request.status = 'resolved'; request.resolution = resolution;
    await this.audit({ type: 'resolved', requestId: id, resolution, resolvedAt: this.now() });
    this.publish('permission.resolved', { requestId: id, resolution });
    return request;
  }

  private builtin(operation: PermissionOperation, profile: PermissionProfileName): PermissionDecision {
    if (profile === 'unrestricted') return 'allow';
    const kind = operation.kind.toLowerCase();
    if (profile === 'readonly' && (kind.startsWith('network.') || kind === 'web.search' || kind === 'mcp.call')) return 'deny';
    if (profile === 'readonly' && (kind.startsWith('filesystem.write') || kind.startsWith('filesystem.edit') || kind.startsWith('process.'))) return 'deny';
    if (profile === 'workspace' && kind.startsWith('filesystem.')) {
      if (!operation.workspace || !operation.path || !isWithin(operation.workspace, operation.path)) return 'deny';
    }
    if (profile === 'automation' && (kind.startsWith('filesystem.write') || kind.startsWith('filesystem.edit') || kind.startsWith('process.')) && operation.workspace && operation.path && !isWithin(operation.workspace, operation.path)) return 'deny';
    return 'allow';
  }

  private publish(type: AppEvent['type'], data: unknown): void { this.options.publish?.({ id: randomUUID(), type, timestamp: this.now(), data }); }
  private async audit(record: Record<string, unknown>): Promise<void> {
    await mkdir(this.options.dataDir, { recursive: true });
    await appendFile(join(this.options.dataDir, 'permission-audit.jsonl'), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

function isWithin(root: string, target: string): boolean {
  const r = resolve(root).toLowerCase(); const t = resolve(target).toLowerCase();
  const rel = relative(r, t); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('/') && !rel.startsWith('\\'));
}
