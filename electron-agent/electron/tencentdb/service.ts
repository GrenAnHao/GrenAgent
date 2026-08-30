import { createHash, randomBytes } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
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
  runtimeConfigPath?: string;
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
  private readonly runtimeConfigPath?: string;
  private lastLocalStatus: TencentDbRuntimeStatus | null = null;

  constructor(options: TencentDbServiceOptions = {}) {
    this.secrets = options.secrets ?? memorySecrets;
    this.configStore = options.configStore;
    this.layout = options.layout;
    this.memoryRuntime = options.memoryRuntime;
    this.panelRuntime = options.panelRuntime;
    this.dataDir = options.dataDir ?? join(process.cwd(), '.runtime', 'tencentdb-memory');
    this.fetchImpl = options.fetch ?? fetch;
    this.runtimeConfigPath = options.runtimeConfigPath;
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
    config.lastSuccessAt = undefined;
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
    const state = this.config.mode === 'local'
      ? (this.lastLocalStatus?.state ?? this.memoryRuntime?.getState() ?? 'stopped')
      : (this.config.lastSuccessAt ? 'ready' : 'stopped');
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

  async testConnection(): Promise<TencentDbStatus> {
    const credentials = await this.resolveCredentials();
    let endpoint = this.config.endpoint;
    if (this.config.mode === 'local') {
      if (!this.memoryRuntime) throw new Error('TencentDB runtime is unavailable');
      this.lastLocalStatus = await this.memoryRuntime.startLocal({ dataDir: this.dataDir, gatewayApiKey: credentials.gatewayApiKey });
      endpoint = this.lastLocalStatus.endpoint;
    }
    if (!endpoint.trim()) throw new Error('TencentDB Gateway endpoint is unavailable');
    const base = endpoint.replace(/\/$/, '');
    const auth = await this.fetchImpl(`${base}/v3/meta/auth/verify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credentials.gatewayApiKey}`, 'x-tdai-service-id': this.config.serviceId, 'content-type': 'application/json' },
      body: JSON.stringify({ user_key: credentials.userKey }),
    });
    const authEnvelope = await auth.json() as { code?: unknown; data?: { valid?: unknown }; message?: unknown };
    if (!auth.ok || authEnvelope.code !== 0 || authEnvelope.data?.valid !== true) throw new Error(`TencentDB User Key is invalid for service ${this.config.serviceId}`);
    await this.coreRequest('/v3/meta/team/get', { team_id: this.config.teamId });
    await this.coreRequest('/v3/meta/team-member/get', { team_id: this.config.teamId, user_id: this.config.userId });
    await this.coreRequest('/v3/meta/agent/get', { agent_id: this.config.agentId });
    if (this.config.knowledgeEndpoint) {
      const health = await this.fetchImpl(`${this.config.knowledgeEndpoint.replace(/\/$/, '')}/health`);
      if (!health.ok) throw new Error(`TencentDB Knowledge health returned ${health.status}`);
    }
    this.config.lastSuccessAt = new Date().toISOString();
    await this.configStore?.write(this.config);
    return this.status();
  }

  async provisionWorkspaceAssets(workspace: string): Promise<{ codeGraphId?: string; wikiId?: string; repoUrl: string; branch: string; error?: string; updatedAt: string }> {
    const path = await realpath(workspace);
    const source = await workspaceSource(path);
    const config = this.getConfig();
    let codeGraphId: string | undefined;
    let wikiId: string | undefined;
    const errors: string[] = [];
    try {
      const created = await this.knowledgeRequest('/code-graph/create', {
        team_id: config.teamId, repo_url: source.repoUrl, branch: source.branch, repo_name: source.repoName,
        user_id: config.userId, agent_id: config.agentId, task_id: config.taskId,
      });
      codeGraphId = extractId(created, 'code_graph_id');
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    try {
      const created = await this.knowledgeRequest('/wiki/create', {
        team_id: config.teamId, name: source.repoName, user_id: config.userId, agent_id: config.agentId, task_id: config.taskId,
      });
      wikiId = extractId(created, 'wiki_id');
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    if (!codeGraphId && !wikiId) throw new Error(errors.join('; ') || 'TencentDB asset provisioning failed');
    return { codeGraphId, wikiId, repoUrl: source.repoUrl, branch: source.branch, error: errors.length ? errors.join('; ') : undefined, updatedAt: new Date().toISOString() };
  }

  async reloadSkills(): Promise<string> {
    const revision = randomBytes(16).toString('hex');
    const path = this.runtimeConfigPath ?? join(this.dataDir, 'runtime-settings.json');
    let settings: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    settings.PI_RELOAD_REV = revision;
    const { mkdir, rename, writeFile } = await import('node:fs/promises');
    await mkdir(join(path, '..'), { recursive: true });
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
    return revision;
  }

  async importWikiFiles(wikiId: string, paths: string[]): Promise<{ uploaded: number; sync: unknown }> {
    if (!wikiId.trim()) throw new Error('wikiId is required');
    if (paths.length < 1 || paths.length > 50) throw new Error('Wiki import accepts between 1 and 50 files');
    const allowed = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc', '.json', '.yaml', '.yml']);
    const files: Array<{ filename: string; content: string }> = [];
    let total = 0;
    for (const input of paths) {
      const path = await realpath(input);
      const extension = extname(path).toLowerCase();
      if (!allowed.has(extension)) throw new Error(`Unsupported Wiki file extension: ${extension}`);
      const content = await readFile(path, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > 512 * 1024) throw new Error(`Wiki document exceeds 512 KiB: ${path}`);
      total += Buffer.byteLength(content, 'utf8');
      if (total > 5 * 1024 * 1024) throw new Error('Wiki import exceeds the 5 MiB total limit');
      files.push({ filename: basename(path), content });
    }
    const config = this.getConfig();
    await this.knowledgeRequest('/wiki/raw/write', { team_id: config.teamId, wiki_id: wikiId, files, user_id: config.userId });
    const sync = await this.knowledgeRequest('/wiki/ingest', { wiki_id: wikiId, user_id: config.userId });
    return { uploaded: files.length, sync };
  }

  private readonly layout?: TencentDbLayout;
}

async function workspaceSource(path: string): Promise<{ repoUrl: string; branch: string; repoName: string }> {
  const fallback = { repoUrl: path, branch: 'main', repoName: basename(path) || 'workspace' };
  try {
    const [origin, branch] = await Promise.all([
      execFile('git', ['config', '--get', 'remote.origin.url'], { cwd: path, windowsHide: true }),
      execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path, windowsHide: true }),
    ]);
    const repoUrl = origin.stdout.trim() || fallback.repoUrl;
    return { repoUrl, branch: branch.stdout.trim() || fallback.branch, repoName: basename(repoUrl.replace(/[\\/]$/, '')).replace(/\.git$/i, '') || fallback.repoName };
  } catch { return fallback; }
}

function extractId(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  const direct = object[key];
  return typeof direct === 'string' ? direct : typeof object.id === 'string' ? object.id : undefined;
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
