import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { panelUrl, panelConnectionFingerprint, type PanelConnection } from './panel';
import { TencentDbPanelRuntime } from './panelRuntime';
import { TencentDbRuntime, type TencentDbRuntimeStatus } from './runtime';
import type { TencentDbLayout } from './layout';

export interface TencentDbConnectionConfig {
  mode: 'local' | 'remote';
  endpoint: string;
  knowledgeEndpoint?: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  taskId?: string;
  lastSuccessAt?: string;
}

export interface SaveTencentDbConnection {
  config: TencentDbConnectionConfig;
  gatewayApiKey?: string;
  clearGatewayApiKey?: boolean;
  userApiKey?: string;
  clearUserApiKey?: boolean;
}

export interface TencentDbSecretStore {
  get(key: TencentDbSecretKey): Promise<string | undefined>;
  set(key: TencentDbSecretKey, value: string): Promise<void>;
  clear(key: TencentDbSecretKey): Promise<void>;
}

export interface TencentDbConfigStore {
  read(): Promise<Partial<TencentDbConnectionConfig> | null>;
  write(config: TencentDbConnectionConfig): Promise<void>;
}

export type TencentDbSecretKey = 'localGatewayApiKey' | 'remoteGatewayApiKey' | 'userApiKey';

export interface TencentDbStatus {
  mode: TencentDbConnectionConfig['mode'];
  endpoint: string;
  knowledgeEndpoint?: string;
  state: 'stopped' | 'starting' | 'ready' | 'failed' | 'restart_required';
  credentialConfigured: boolean;
  userCredentialConfigured: boolean;
  lastSuccessAt?: string;
  restartRequired?: boolean;
}

export interface TencentDbServiceOptions {
  secrets?: TencentDbSecretStore;
  configStore?: TencentDbConfigStore;
  layout?: TencentDbLayout;
  memoryRuntime?: TencentDbRuntime;
  panelRuntime?: TencentDbPanelRuntime;
  dataDir?: string;
  fetch?: typeof fetch;
}

const DEFAULT_CONFIG: TencentDbConnectionConfig = {
  mode: 'local',
  endpoint: '',
  serviceId: 'personal-memory',
  teamId: 'personal-local',
  agentId: 'pi-personal',
  userId: 'local',
};

const memorySecrets: TencentDbSecretStore = {
  values: new Map(),
  async get(key) { return this.values.get(key); },
  async set(key, value) { this.values.set(key, value); },
  async clear(key) { this.values.delete(key); },
} as TencentDbSecretStore & { values: Map<string, string> };

export class TencentDbService {
  private config: TencentDbConnectionConfig = { ...DEFAULT_CONFIG };
  private readonly secrets: TencentDbSecretStore;
  private readonly configStore?: TencentDbConfigStore;
  private readonly memoryRuntime?: TencentDbRuntime;
  private readonly panelRuntime?: TencentDbPanelRuntime;
  private readonly dataDir: string;
  private readonly fetchImpl: typeof fetch;
  private lastLocalStatus: TencentDbRuntimeStatus | null = null;

  constructor(options: TencentDbServiceOptions = {}) {
    this.secrets = options.secrets ?? memorySecrets;
    this.configStore = options.configStore;
    this.layout = options.layout;
    this.memoryRuntime = options.memoryRuntime;
    this.panelRuntime = options.panelRuntime;
    this.dataDir = options.dataDir ?? join(process.cwd(), '.runtime', 'tencentdb-memory');
    this.fetchImpl = options.fetch ?? fetch;
  }

  async load(): Promise<void> {
    const stored = await this.configStore?.read();
    if (stored) this.config = normalizeConfig({ ...DEFAULT_CONFIG, ...stored } as TencentDbConnectionConfig);
  }

  getConfig(): TencentDbConnectionConfig {
    return { ...this.config };
  }

  async resolveCredentials(): Promise<{ gatewayApiKey: string; userKey: string }> {
    const gatewayKeyName: TencentDbSecretKey = this.config.mode === 'local' ? 'localGatewayApiKey' : 'remoteGatewayApiKey';
    let gatewayApiKey = await this.secrets.get(gatewayKeyName);
    if (!gatewayApiKey && this.config.mode === 'local') {
      gatewayApiKey = randomBytes(16).toString('hex');
      await this.secrets.set(gatewayKeyName, gatewayApiKey);
    }
    if (!gatewayApiKey?.trim()) {
      throw new Error('TencentDB remote Gateway credential is not configured');
    }
    if (this.config.mode === 'local') {
      return { gatewayApiKey, userKey: localUserApiKey(gatewayApiKey) };
    }
    const userKey = await this.secrets.get('userApiKey');
    if (!userKey?.trim()) throw new Error('TencentDB remote User Key is not configured');
    return { gatewayApiKey, userKey };
  }

  async saveConnection(input: SaveTencentDbConnection): Promise<TencentDbStatus> {
    const config = normalizeConfig(input.config);
    validateConfig(config);
    const gatewayKeyName: TencentDbSecretKey = config.mode === 'local' ? 'localGatewayApiKey' : 'remoteGatewayApiKey';
    if (input.clearGatewayApiKey) await this.secrets.clear(gatewayKeyName);
    if (input.gatewayApiKey?.trim()) await this.secrets.set(gatewayKeyName, input.gatewayApiKey.trim());
    if (input.clearUserApiKey) await this.secrets.clear('userApiKey');
    if (input.userApiKey?.trim()) await this.secrets.set('userApiKey', input.userApiKey.trim());
    this.config = config;
    await this.configStore?.write(config);
    return this.status();
  }

  async status(): Promise<TencentDbStatus> {
    const gatewayKeyName: TencentDbSecretKey = this.config.mode === 'local' ? 'localGatewayApiKey' : 'remoteGatewayApiKey';
    const gatewayConfigured = Boolean(await this.secrets.get(gatewayKeyName));
    const userConfigured = this.config.mode === 'local' ? gatewayConfigured : Boolean(await this.secrets.get('userApiKey'));
    const state = this.config.mode === 'local' ? (this.lastLocalStatus?.state ?? this.memoryRuntime?.getState() ?? 'stopped') : 'stopped';
    return {
      mode: this.config.mode,
      endpoint: this.lastLocalStatus?.endpoint || this.config.endpoint,
      knowledgeEndpoint: this.lastLocalStatus?.knowledgeEndpoint || this.config.knowledgeEndpoint,
      state,
      credentialConfigured: gatewayConfigured,
      userCredentialConfigured: userConfigured,
      lastSuccessAt: this.config.lastSuccessAt,
      restartRequired: false,
    };
  }

  async openPanel(): Promise<{ url: string }> {
    if (!this.panelRuntime || !this.layout) {
      throw new Error('TencentDB Panel runtime is unavailable');
    }
    const credentials = await this.resolveCredentials();
    let gatewayEndpoint = this.config.endpoint;
    let knowledgeEndpoint = this.config.knowledgeEndpoint ?? '';
    if (this.config.mode === 'local') {
      if (!this.memoryRuntime) throw new Error('TencentDB runtime is unavailable');
      this.lastLocalStatus = await this.memoryRuntime.startLocal({
        dataDir: this.dataDir,
        gatewayApiKey: credentials.gatewayApiKey,
      });
      gatewayEndpoint = this.lastLocalStatus.endpoint;
      knowledgeEndpoint = this.lastLocalStatus.knowledgeEndpoint;
    }
    if (!gatewayEndpoint.trim() || !knowledgeEndpoint.trim()) throw new Error('TencentDB Gateway endpoint is unavailable');
    const connection: PanelConnection = {
      mode: this.config.mode,
      serviceId: this.config.serviceId,
      userId: this.config.userId,
      gatewayEndpoint,
      knowledgeEndpoint,
      gatewayApiKey: credentials.gatewayApiKey,
      userKey: credentials.userKey,
    };
    const endpoint = await this.panelRuntime.ensureStarted(connection);
    const token = await this.panelRuntime.registerBootstrap(connection);
    return { url: panelUrl(endpoint, token) };
  }

  async coreRequest(route: string, body: Record<string, unknown> = {}): Promise<unknown> {
    if (!/^\/v3\/[a-z0-9/_-]+$/.test(route)) throw new Error(`TencentDB Core route is not allowed: ${route}`);
    const credentials = await this.resolveCredentials();
    let endpoint = this.config.endpoint;
    if (this.config.mode === 'local') {
      if (!this.memoryRuntime) throw new Error('TencentDB runtime is unavailable');
      this.lastLocalStatus = await this.memoryRuntime.startLocal({ dataDir: this.dataDir, gatewayApiKey: credentials.gatewayApiKey });
      endpoint = this.lastLocalStatus.endpoint;
    }
    const requestBody = { ...body, team_id: this.config.teamId, agent_id: this.config.agentId, user_id: this.config.userId };
    const response = await this.fetchImpl(`${endpoint.replace(/\/$/, '')}${route}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credentials.gatewayApiKey}`,
        'content-type': 'application/json',
        'x-tdai-service-id': this.config.serviceId,
        'x-tdai-user-key': credentials.userKey,
      },
      body: JSON.stringify(requestBody),
    });
    const envelope = await response.json() as { code?: unknown; message?: unknown; data?: unknown };
    if (!response.ok || envelope.code !== 0) throw new Error(`TencentDB Core request failed (${response.status}): ${String(envelope.message ?? 'unknown error')}`);
    return envelope.data ?? {};
  }

  async knowledgeRequest(route: string, body: Record<string, unknown> = {}): Promise<unknown> {
    if (!/^\/?(?:v3\/)?[a-z0-9/_-]+$/i.test(route)) throw new Error(`TencentDB Knowledge route is not allowed: ${route}`);
    const credentials = await this.resolveCredentials();
    let endpoint = this.config.knowledgeEndpoint;
    if (this.config.mode === 'local') {
      if (!this.memoryRuntime) throw new Error('TencentDB runtime is unavailable');
      this.lastLocalStatus = await this.memoryRuntime.startLocal({ dataDir: this.dataDir, gatewayApiKey: credentials.gatewayApiKey });
      endpoint = this.lastLocalStatus.knowledgeEndpoint;
    }
    if (!endpoint?.trim()) throw new Error('TencentDB Knowledge endpoint is unavailable');
    const base = endpoint.replace(/\/$/, '').replace(/\/v3$/i, '');
    const response = await this.fetchImpl(`${base}/v3/${route.replace(/^\/?(?:v3\/)?/i, '')}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credentials.gatewayApiKey}`,
        'content-type': 'application/json',
        'x-tdai-service-id': this.config.serviceId,
        'x-tdai-user-key': credentials.userKey,
      },
      body: JSON.stringify(body),
    });
    const envelope = await response.json() as { code?: unknown; message?: unknown; data?: unknown };
    if (envelope.code !== 0) throw new Error(`TencentDB Knowledge request failed (${response.status}): ${String(envelope.message ?? 'unknown error')}`);
    if (envelope.data === undefined) throw new Error('TencentDB Knowledge returned no data');
    return envelope.data;
  }

  private readonly layout?: TencentDbLayout;
}

function normalizeConfig(config: TencentDbConnectionConfig): TencentDbConnectionConfig {
  return {
    ...config,
    endpoint: config.endpoint.trim().replace(/\/$/, ''),
    knowledgeEndpoint: config.knowledgeEndpoint?.trim().replace(/\/$/, '') || undefined,
    serviceId: config.serviceId.trim(),
    teamId: config.teamId.trim(),
    agentId: config.agentId.trim(),
    userId: config.userId.trim(),
    taskId: config.taskId?.trim() || undefined,
  };
}

function validateConfig(config: TencentDbConnectionConfig): void {
  for (const [label, value] of [['serviceId', config.serviceId], ['teamId', config.teamId], ['agentId', config.agentId], ['userId', config.userId]] as const) {
    if (!value) throw new Error(`TencentDB ${label} must not be empty`);
  }
  if (config.mode !== 'remote') return;
  if (!config.endpoint) throw new Error('TencentDB remote endpoint is required');
  if (!config.knowledgeEndpoint) throw new Error('TencentDB remote Knowledge endpoint is required');
  for (const [label, value] of [['endpoint', config.endpoint], ['knowledge endpoint', config.knowledgeEndpoint]] as const) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`TencentDB ${label} must be a valid URL`); }
    if (url.protocol !== 'https:') throw new Error(`TencentDB ${label} must use HTTPS`);
    if (url.username || url.password || url.search || url.hash) throw new Error(`TencentDB ${label} must not contain credentials, query, or fragment`);
  }
}

function localUserApiKey(gatewayApiKey: string): string {
  return `sk-mem-${createHash('sha256').update(`GrenAgent TencentDB managed user\0${gatewayApiKey}`).digest('hex').slice(0, 32)}`;
}
