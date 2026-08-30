import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { TencentDbLayout } from './layout';
import { panelConnectionFingerprint, type PanelConnection } from './panel';

export interface PanelSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  stdio: ['ignore', 'pipe', 'pipe'];
  windowsHide: boolean;
}

export type PanelSpawn = (
  command: string,
  args: string[],
  options: PanelSpawnOptions,
) => ChildProcessWithoutNullStreams;

export type PanelFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TencentDbPanelRuntimeOptions {
  spawn?: PanelSpawn;
  fetch?: PanelFetch;
  startupTimeoutMs?: number;
  healthTimeoutMs?: number;
  retryDelayMs?: number;
  onLog?: (line: string) => void;
}

interface RunningPanel {
  child: ChildProcessWithoutNullStreams;
  endpoint: string;
  fingerprint: string;
  sharedSecret: string;
}

const START_ATTEMPTS = 3;
const BOOTSTRAP_TTL_MS = 60_000;

export class TencentDbPanelRuntime {
  private process: RunningPanel | null = null;
  private shuttingDown = false;
  private lifecycle = Promise.resolve();
  private readonly spawnProcess: PanelSpawn;
  private readonly fetchImpl: PanelFetch;

  constructor(
    private readonly layout: TencentDbLayout,
    private readonly options: TencentDbPanelRuntimeOptions = {},
  ) {
    this.spawnProcess = options.spawn ?? (spawn as unknown as PanelSpawn);
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as PanelFetch);
  }

  ensureStarted(connection: PanelConnection): Promise<string> {
    return this.enqueue(() => this.start(connection));
  }

  async registerBootstrap(connection: PanelConnection): Promise<string> {
    const running = this.process;
    if (!running) throw new Error('TencentDB Panel runtime is not started');
    if (!isRunning(running.child)) throw new Error('TencentDB Panel runtime is not running');
    if (running.fingerprint !== panelConnectionFingerprint(connection)) {
      throw new Error('TencentDB Panel connection changed; restart is required');
    }

    const token = randomBytes(16).toString('hex');
    const response = await fetchWithTimeout(
      this.fetchImpl,
      `${running.endpoint}/__grenagent/bootstrap/register`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tdai-panel-shared-secret': running.sharedSecret,
        },
        body: JSON.stringify({
          token,
          instance_id: connection.serviceId,
          user_key: connection.userKey,
          expires_at: Date.now() + BOOTSTRAP_TTL_MS,
        }),
      },
      3_000,
    );
    if (!response.ok) throw new Error(`TencentDB Panel rejected bootstrap registration (${response.status})`);
    return token;
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      const running = this.process;
      this.process = null;
      if (running) await stopChild(running.child);
    });
  }

  shutdown(): Promise<void> {
    this.shuttingDown = true;
    return this.stop();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(operation, operation);
    this.lifecycle = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async start(connection: PanelConnection): Promise<string> {
    if (this.shuttingDown) throw new Error('TencentDB Panel runtime is shutting down');
    const fingerprint = panelConnectionFingerprint(connection);
    if (this.process && isRunning(this.process.child) && this.process.fingerprint === fingerprint) {
      return this.process.endpoint;
    }
    if (this.process) {
      await stopChild(this.process.child);
      this.process = null;
    }
    if (!connection.gatewayApiKey.trim() || !connection.userKey.trim()) {
      throw new Error('TencentDB Panel credentials must not be empty');
    }

    this.layout.assertReady();
    let lastError: unknown;
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
      try {
        const running = await this.startAttempt(connection, fingerprint);
        this.process = running;
        return running.endpoint;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < START_ATTEMPTS) await sleep(this.options.retryDelayMs ?? 50);
      }
    }
    throw new Error(`TencentDB MemoryPanel did not become healthy after retries: ${formatError(lastError)}`);
  }

  private async startAttempt(connection: PanelConnection, fingerprint: string): Promise<RunningPanel> {
    const directory = await mkdtemp(join(tmpdir(), 'grenagent-panel-'));
    const portFile = join(directory, 'port');
    const sharedSecret = randomBytes(16).toString('hex');
    const registry = JSON.stringify([
      {
        id: connection.serviceId,
        name: connection.serviceId,
        gateway_endpoint: connection.gatewayEndpoint,
        proxy_endpoint: connection.gatewayEndpoint,
        api_key: connection.gatewayApiKey,
      },
    ]);
    const env = withProcessEnv({
      HOST: '127.0.0.1',
      PORT: '0',
      TDAI_PANEL_PORT_FILE: portFile,
      UI_DIST_DIR: join(this.layout.root, 'panel', 'web', 'dist'),
      KNOWLEDGE_SERVICE_URL: connection.knowledgeEndpoint,
      KNOWLEDGE_AUTH_TOKEN: connection.gatewayApiKey,
      TDAI_PANEL_INSTANCES_JSON: registry,
      TDAI_PANEL_BOOTSTRAP_SECRET: sharedSecret,
      KNOWLEDGE_LLM_BINDING_SYNC: 'false',
    });
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      child = this.spawnProcess(this.layout.node(), [this.layout.panelEntry()], {
        cwd: this.layout.root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      attachLogs(child, this.options.onLog);
      const port = await waitForPanelPort(
        portFile,
        child,
        () => this.shuttingDown,
        this.options.startupTimeoutMs ?? 20_000,
      );
      const endpoint = `http://127.0.0.1:${port}`;
      await waitForPanelHealth(
        endpoint,
        sharedSecret,
        this.fetchImpl,
        () => this.shuttingDown,
        this.options.healthTimeoutMs ?? 20_000,
      );
      return { child, endpoint, fingerprint, sharedSecret };
    } catch (error) {
      if (child) await stopChild(child);
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export function parsePanelPort(value: string): number {
  if (!value || value.trim() !== value || !/^\d+$/.test(value)) {
    throw new Error('Panel reported an invalid port');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Panel reported an invalid port');
  }
  return port;
}

async function waitForPanelPort(
  path: string,
  child: ChildProcessWithoutNullStreams,
  isShuttingDown: () => boolean,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (isShuttingDown()) throw new Error('TencentDB runtime is shutting down');
    if (!isRunning(child)) throw new Error('TencentDB MemoryPanel exited before reporting its port');
    try {
      return parsePanelPort(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') lastError = error;
    }
    await sleep(50);
  }
  throw lastError instanceof Error ? lastError : new Error('Panel did not report a listening port');
}

async function waitForPanelHealth(
  endpoint: string,
  sharedSecret: string,
  fetchImpl: PanelFetch,
  isShuttingDown: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'health check timed out';
  while (Date.now() < deadline) {
    if (isShuttingDown()) throw new Error('TencentDB runtime is shutting down');
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        `${endpoint}/__grenagent/health`,
        { headers: { 'x-tdai-panel-shared-secret': sharedSecret } },
        2_000,
      );
      if (response.ok) return;
      if (response.status >= 400 && response.status < 500) throw new Error(`Panel health check returned ${response.status}`);
      lastError = `Panel health check returned ${response.status}`;
    } catch (error) {
      lastError = formatError(error);
    }
    await sleep(250);
  }
  throw new Error(lastError);
}

async function fetchWithTimeout(fetchImpl: PanelFetch, input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function withProcessEnv(values: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return { ...env, ...values };
}

function attachLogs(child: ChildProcessWithoutNullStreams, onLog?: (line: string) => void): void {
  if (!onLog) return;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => onLog(`[tencentdb:panel] ${chunk.trim()}`));
  child.stderr.on('data', (chunk: string) => onLog(`[tencentdb:panel] ${chunk.trim()}`));
}

function isRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && !child.killed;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!isRunning(child)) return;
  try {
    child.stdin.end();
  } catch {
    // The process may already have closed stdin during shutdown.
  }
  await Promise.race([waitForClose(child, 5_000), sleep(5_000)]);
  if (isRunning(child)) child.kill();
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (!isRunning(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve();
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('close', onClose);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
