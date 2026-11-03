import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { RpcPeer, type WireMessage } from '../agentProcess/rpcPeer';
import type { AgentDataLaunchState, AgentDataProcessPort } from './agentDataService';
import type { AgentDataModelPort } from '../agentDataProcess/assemble';
import { AGENTDATA_MODEL_USAGE_CHANNEL } from '../agentDataProcess/contract';

export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function bounded<T>(promise: Promise<T>, label: string, ms = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer!); }
}
export async function until(predicate: () => boolean | Promise<boolean>, label: string, ms = 12_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await pause(20); }
  throw new Error(`Timed out: ${label}`);
}

export type ProviderCall = {
  body: Record<string, any>;
  headers: IncomingHttpHeaders;
  kind: 'repo' | 'legacy' | 'probe';
  user: string;
  aborted: boolean;
  settled: boolean;
  release(): void;
};

/** A real loopback HTTP provider. SDK model resolution, serialization and abort are production code. */
export async function fixtureProvider(log: (message: string) => void) {
  const calls: ProviderCall[] = [];
  let hold: (call: ProviderCall) => boolean = () => false;
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const user = body.messages.findLast((message: any) => message.role === 'user')?.content ?? '';
    let context: any;
    try { context = JSON.parse(user); } catch { /* Legacy Wiki prompts are plain text. */ }
    const kind = context?.files ? 'repo' : user.startsWith('workflow-probe:') ? 'probe' : 'legacy';
    const call: ProviderCall = { body, headers: req.headers, user, kind, aborted: false, settled: false, release: () => {} };
    call.release = () => {
      if (call.settled) return;
      call.settled = true;
      let text: string;
      if (kind === 'repo') {
        const file = context.files.find((item: any) => item.content.trim());
        text = JSON.stringify({ markdown: `# ${context.title}\nVerified workflow evidence from ${file.path}.\n`,
          sources: [{ path: file.path, start_line: 1, end_line: 1 }] });
      } else if (kind === 'probe') text = 'workflow-probe:ok';
      else text = '<<<FILE path="wiki/concepts/workflow.md">>>\n---\ntitle: Workflow\ntype: concept\n---\n# Workflow\nThe source describes the integration workflow.\n<<<END>>>';
      respondSse(res, body.model, text);
      log(`provider completed kind=${kind} model=${body.model}`);
    };
    res.on('close', () => {
      if (!call.settled) { call.aborted = true; call.settled = true; log(`provider aborted kind=${kind} model=${body.model}`); }
    });
    calls.push(call);
    log(`provider entered kind=${kind} model=${body.model} max_tokens=${body.max_tokens ?? body.max_completion_tokens}`);
    if (!hold(call)) call.release();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture provider address');
  return {
    calls, baseUrl: `http://127.0.0.1:${address.port}/v1`,
    hold: (predicate: typeof hold) => { hold = predicate; },
    close: async () => { for (const call of calls) call.release(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

function respondSse(res: ServerResponse, model: string, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
  const base = { id: 'workflow-fixture', object: 'chat.completion.chunk', created: 1, model };
  event({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
  event({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } });
  res.end('data: [DONE]\n\n');
}

/** Actual Electron-as-Node OS child using production RpcPeer and createAgentDataHost. */
export function agentDataOsPort(options: {
  entry: string; executable: string; dataPath: string; configPath: string;
  launchState(): AgentDataLaunchState;
  model: AgentDataModelPort;
  log(message: string): void;
  mainMethod?(name: string, params: Record<string, unknown>): Promise<unknown> | unknown;
  knowledgeKernelVersion?: 1;
  /** Per-request bound; real-model runs need more than a fake provider's 25s. */
  requestTimeoutMs?: number;
}) {
  let child: ChildProcess | undefined;
  let peer: RpcPeer | undefined;
  let starting: Promise<void> | undefined;
  const aborts = new Map<string, AbortController>();
  const requests: string[] = [];
  let nodeVersion = '';
  const port: AgentDataProcessPort = {
    start: () => starting ??= (async () => {
      const forkOptions: ForkOptions & { windowsHide: boolean } = {
        execPath: options.executable,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PI_RUNTIME_CONFIG: options.configPath,
          AGENTDATA_HOST_CONFIG: JSON.stringify({ ...options.launchState(), dataPath: options.dataPath,
            codeGraph: { hostEntry: '', workerEntry: '', jobGuardExe: '', execPath: '' }, knowledgeKernelVersion: options.knowledgeKernelVersion }) },
        serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
      };
      child = fork(options.entry, [], forkOptions);
      const running = child;
      peer = new RpcPeer({ send: (message: WireMessage) => {
        running.send(message, error => { if (error) peer?.close(error); });
      } });
      const activePeer = peer;
      peer.handleAll({
        'main.model.describe': () => options.model.describe(),
        'main.model.complete': async (p) => {
          const controller = new AbortController();
          const requestId = p.requestId as string;
          aborts.set(requestId, controller);
          options.log(`reverse main.model.complete expected=${(p.input as any).expectedModel ?? ''}`);
          try {
            return await options.model.complete({ ...(p.input as any), signal: controller.signal,
              ...(p.withUsage ? { onUsage: (report: unknown) => activePeer.emit(AGENTDATA_MODEL_USAGE_CHANNEL, { requestId, report }) } : {}) });
          } finally { aborts.delete(requestId); }
        },
        'main.model.abort': (p) => { aborts.get(p.requestId as string)?.abort(); options.log('reverse main.model.abort'); return null; },
        'main.resolveSession': () => false,
        'main.method': (p) => options.mainMethod?.(p.name as string, (p.params ?? {}) as Record<string, unknown>) ?? null,
      });
      const ready = new Promise<void>((resolve, reject) => {
        activePeer.onEvent((channel, payload: any) => {
          if (channel === 'host.ready') { nodeVersion = payload.node; options.log(`agentdata ready pid=${payload.pid} node=${nodeVersion}`); resolve(); }
        });
        running.once('error', reject);
        running.once('exit', (code) => { activePeer.close(new Error(`AgentData fixture exited ${code}`)); reject(new Error(`AgentData fixture exited ${code}`)); });
      });
      running.on('message', (message) => activePeer.receive(message));
      running.stderr?.on('data', (bytes) => options.log(`agentdata stderr: ${bytes.toString().trim()}`));
      running.stdout?.on('data', (bytes) => options.log(`agentdata stdout: ${bytes.toString().trim()}`));
      await bounded(ready, 'AgentData OS child startup');
    })(),
    request: async (method, params = {}) => {
      await port.start(); requests.push(method); options.log(`private ${method}`);
      return bounded(peer!.request(method, params), method, options.requestTimeoutMs ?? 25_000);
    },
    shutdown: async () => {
      if (!child || child.exitCode !== null) return;
      try { await bounded(peer!.request('host.shutdown'), 'AgentData shutdown', 5000); }
      finally {
        if (child.exitCode === null) {
          try { await bounded(once(child, 'exit'), 'AgentData exit', 3000); }
          catch { child.kill(); }
        }
        for (const controller of aborts.values()) controller.abort();
      }
    },
    get isRunning() { return child !== undefined && child.exitCode === null; },
  };
  return { port, requests, get pid() { return child?.pid; }, get nodeVersion() { return nodeVersion; } };
}
