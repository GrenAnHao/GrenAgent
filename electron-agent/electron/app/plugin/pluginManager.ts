import { randomUUID } from 'node:crypto';
import type { AgentDataStorage } from '../../agentData/storage';
import type { AppEvent, PermissionProfile } from '../appServer/types';

export const PLUGIN_CAPABILITIES = ['agent', 'tool', 'mcp', 'provider', 'ui', 'event-subscriber'] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export interface PluginManifest {
  id: string;
  version: string;
  apiVersion: string;
  capabilities: PluginCapability[];
  permissions?: Partial<PermissionProfile>;
}

export type PluginStateName =
  | 'discovered'
  | 'validated'
  | 'loaded'
  | 'started'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'validation_failed'
  | 'start_failed'
  | 'crashed'
  | 'disabled';

export interface PluginInstance {
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface PluginDefinition {
  id: string;
  manifest: PluginManifest;
  load(): PluginInstance | Promise<PluginInstance>;
}

export interface PluginStateRecord {
  id: string;
  version: string;
  state: PluginStateName;
  manifest: PluginManifest;
  updatedAt: number;
  error?: string;
}

export interface PluginManagerOptions {
  storage: Pick<AgentDataStorage, 'db'>;
  apiVersion: string;
  publish?: (event: Omit<AppEvent, 'sequence'>) => void;
  now?: () => number;
}

const permissionValues: { [K in keyof PermissionProfile]: readonly PermissionProfile[K][] } = {
  filesystem: ['none', 'workspace-read', 'workspace-write', 'unrestricted'],
  network: ['none', 'allowlist', 'full'],
  process: ['none', 'allowlist', 'full'],
  secrets: ['none', 'selected', 'all'],
  interaction: ['deny', 'ask', 'auto'],
};

/** Electron-owned plugin state machine. Loading is delegated to adapters and never creates a plugin process. */
export class PluginManager {
  private readonly definitions = new Map<string, PluginDefinition>();
  private readonly instances = new Map<string, PluginInstance>();
  private readonly states = new Map<string, PluginStateRecord>();
  private readonly now: () => number;

  constructor(private readonly options: PluginManagerOptions) {
    this.now = options.now ?? Date.now;
    this.restore();
  }

  discover(definitions: PluginDefinition[]): PluginStateRecord[] {
    const discovered: PluginStateRecord[] = [];
    for (const definition of definitions) {
      this.definitions.set(definition.id, definition);
      this.transition(definition, 'discovered');
      const error = this.validate(definition);
      discovered.push(this.transition(definition, error ? 'validation_failed' : 'validated', error));
    }
    return discovered;
  }

  async start(id: string): Promise<PluginStateRecord> {
    const definition = this.requireDefinition(id);
    const current = this.requireState(id);
    if (current.state === 'ready') return current;
    if (current.state === 'validation_failed') return current;
    try {
      const instance = await definition.load();
      this.instances.set(id, instance);
      this.transition(definition, 'loaded');
      await instance.start?.();
      this.transition(definition, 'started');
      return this.transition(definition, 'ready');
    } catch (error) {
      return this.transition(definition, 'start_failed', errorMessage(error));
    }
  }

  async startAll(): Promise<PluginStateRecord[]> {
    const result: PluginStateRecord[] = [];
    for (const id of this.definitions.keys()) result.push(await this.start(id));
    return result;
  }

  async stop(id: string): Promise<PluginStateRecord> {
    const definition = this.requireDefinition(id);
    const current = this.requireState(id);
    if (current.state === 'stopped') return current;
    if (current.state !== 'ready' && current.state !== 'started') return current;
    this.transition(definition, 'stopping');
    try {
      await this.instances.get(id)?.stop?.();
      this.instances.delete(id);
      return this.transition(definition, 'stopped');
    } catch (error) {
      return this.transition(definition, 'crashed', errorMessage(error));
    }
  }

  get(id: string): PluginStateRecord | undefined {
    return this.states.get(id);
  }

  list(): PluginStateRecord[] {
    return [...this.states.values()].map(copyState);
  }

  allowedPluginIds(): string[] {
    return [...this.definitions.keys()].filter((id) => this.states.get(id)?.state === 'ready');
  }

  private validate(definition: PluginDefinition): string | undefined {
    const manifest = definition.manifest;
    if (!definition.id.trim() || manifest.id !== definition.id) return 'manifest id must match plugin id';
    if (!manifest.version.trim()) return 'manifest version is required';
    if (manifest.apiVersion !== this.options.apiVersion) return `unsupported apiVersion: ${manifest.apiVersion}`;
    if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0
      || manifest.capabilities.some((value) => !PLUGIN_CAPABILITIES.includes(value))) return 'manifest capabilities are invalid';
    if (manifest.permissions && !validPermissions(manifest.permissions)) return 'manifest permissions are invalid';
    return undefined;
  }

  private transition(definition: PluginDefinition, state: PluginStateName, error?: string): PluginStateRecord {
    const record: PluginStateRecord = {
      id: definition.id,
      version: definition.manifest.version,
      state,
      manifest: structuredClone(definition.manifest),
      updatedAt: this.now(),
      ...(error === undefined ? {} : { error }),
    };
    this.states.set(record.id, record);
    this.options.storage.db.prepare(`INSERT INTO plugin_state(id, state, payload, updated_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, payload=excluded.payload, updated_at=excluded.updated_at`)
      .run(record.id, record.state, JSON.stringify(record), record.updatedAt);
    this.options.publish?.({
      id: randomUUID(),
      type: 'plugin.state_changed',
      timestamp: record.updatedAt,
      data: copyState(record),
    });
    return copyState(record);
  }

  private restore(): void {
    const rows = this.options.storage.db.prepare('SELECT payload FROM plugin_state ORDER BY updated_at ASC').all() as Array<{ payload: string }>;
    for (const row of rows) {
      try {
        const record = JSON.parse(row.payload) as PluginStateRecord;
        if (record && typeof record.id === 'string' && typeof record.state === 'string') this.states.set(record.id, record);
      } catch {
        // A corrupt plugin record is isolated from all other plugin state.
      }
    }
  }

  private requireDefinition(id: string): PluginDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`plugin not discovered: ${id}`);
    return definition;
  }

  private requireState(id: string): PluginStateRecord {
    const state = this.states.get(id);
    if (!state) throw new Error(`plugin state not found: ${id}`);
    return state;
  }
}

function validPermissions(permissions: Partial<PermissionProfile>): boolean {
  for (const [key, value] of Object.entries(permissions)) {
    if (!(key in permissionValues) || !(permissionValues[key as keyof PermissionProfile] as readonly unknown[]).includes(value)) return false;
  }
  return true;
}

function copyState(record: PluginStateRecord): PluginStateRecord {
  return structuredClone(record);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
