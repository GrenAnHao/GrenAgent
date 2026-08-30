import { createServer } from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TencentDbLayout } from './layout';

export type TencentDbRuntimeState = 'stopped' | 'starting' | 'ready' | 'failed';

export interface TencentDbRuntimeStatus {
  state: TencentDbRuntimeState;
  endpoint: string;
  knowledgeEndpoint: string;
}

interface LocalProcesses {
  core: ChildProcessWithoutNullStreams;
  knowledge: ChildProcessWithoutNullStreams;
  status: TencentDbRuntimeStatus;
}

export interface StartTencentDbOptions {
  dataDir: string;
  gatewayApiKey: string;
  env?: Record<string, string>;
  onLog?: (line: string) => void;
}

export class TencentDbRuntime {
  private processes: LocalProcesses | null = null;
  private state: TencentDbRuntimeState = 'stopped';

  constructor(private readonly layout: TencentDbLayout) {}

  getState(): TencentDbRuntimeState {
    return this.state;
  }

  async startLocal(options: StartTencentDbOptions): Promise<TencentDbRuntimeStatus> {
    if (this.processes && this.state === 'ready') return this.processes.status;
    if (!options.gatewayApiKey.trim()) throw new Error('TencentDB local gateway API key must not be empty');
    this.layout.assertCoreReady();
    this.state = 'starting';
    const corePort = await freePort();
    const knowledgePort = await freePort();
    const endpoint = `http://127.0.0.1:${corePort}`;
    const knowledgeEndpoint = `http://127.0.0.1:${knowledgePort}/v3`;
    const coreDataDir = join(options.dataDir, 'core');
    const knowledgeDataDir = join(options.dataDir, 'knowledge');
    await mkdir(coreDataDir, { recursive: true });
    await mkdir(knowledgeDataDir, { recursive: true });
    const env = { ...process.env, ...options.env } as Record<string, string>;
    const core = spawn(this.layout.node(), ['--import', 'tsx', 'src/gateway/server.ts'], {
      cwd: join(this.layout.root, 'core'),
      env: {
        ...env,
        TDAI_GATEWAY_CONFIG: this.layout.coreConfig(),
        TDAI_GATEWAY_HOST: '127.0.0.1',
        TDAI_GATEWAY_PORT: String(corePort),
        TDAI_GATEWAY_API_KEY: options.gatewayApiKey,
        TDAI_DATA_DIR: coreDataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const knowledge = spawn(this.layout.node(), [this.layout.knowledgeEntry()], {
      cwd: dirname(this.layout.knowledgeEntry()),
      env: {
        ...env,
        HOST: '127.0.0.1',
        PORT: String(knowledgePort),
        KNOWLEDGE_DATA_DIR: knowledgeDataDir,
        KNOWLEDGE_DB_PATH: join(knowledgeDataDir, 'knowledge.db'),
        KNOWLEDGE_PUBLIC_BASE_URL: knowledgeEndpoint,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const log = (name: string, chunk: Buffer | string) => options.onLog?.(`[tencentdb:${name}] ${String(chunk).trim()}`);
    core.stdout.on('data', (chunk) => log('core', chunk));
    core.stderr.on('data', (chunk) => log('core', chunk));
    knowledge.stdout.on('data', (chunk) => log('knowledge', chunk));
    knowledge.stderr.on('data', (chunk) => log('knowledge', chunk));
    try {
      await Promise.all([waitForHealth(endpoint), waitForHealth(knowledgeEndpoint)]);
    } catch (error) {
      core.kill();
      knowledge.kill();
      this.state = 'failed';
      throw error;
    }
    this.processes = { core, knowledge, status: { state: 'ready', endpoint, knowledgeEndpoint } };
    this.state = 'ready';
    return this.processes.status;
  }

  async stop(): Promise<void> {
    const processes = this.processes;
    this.processes = null;
    this.state = 'stopped';
    if (!processes) return;
    processes.core.kill();
    processes.knowledge.kill();
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('Unable to allocate a loopback port');
  return port;
}

async function waitForHealth(endpoint: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'health check timed out';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(750) });
      if (response.ok) return;
      lastError = `health check returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`TencentDB runtime ${lastError}`);
}
