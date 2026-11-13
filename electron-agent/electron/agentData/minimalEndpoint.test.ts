import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MinimalExtensionEndpoint } from './minimalEndpoint';

let dir: string;
let endpoint: MinimalExtensionEndpoint;
let path: string;
const tokens = new Map([['token-a', 'D:/workspace-a']]);
const codeRetrieval = { call: vi.fn(async () => ({ rows: [] })) };
const toolPermission = {
  evaluate: vi.fn(async () => ({ decision: 'allow' })),
  remember: vi.fn(async () => null),
  settle: vi.fn(async () => null),
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'minimal-endpoint-'));
  // Windows 不支持 Unix socket，用命名管道；POSIX 走临时目录里的 socket。
  path = process.platform === 'win32'
    ? `\\\\.\\pipe\\grenagent-endpoint-test-${process.pid}-${Date.now()}`
    : join(dir, 's.sock');
  codeRetrieval.call.mockClear(); toolPermission.evaluate.mockClear();
  endpoint = new MinimalExtensionEndpoint({ listenPath: path, workspaceTokens: tokens, codeRetrieval, toolPermission });
  await endpoint.start();
});

afterEach(async () => { await endpoint.close(); rmSync(dir, { recursive: true, force: true }); });

const call = (method: string, params: Record<string, unknown>, token = 'token-a') => new Promise<{ ok: boolean; result?: unknown; error?: { code: string } }>((resolve, reject) => {
  const socket = createConnection({ path });
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    const i = buffer.indexOf('\n');
    if (i < 0) return;
    socket.destroy();
    resolve(JSON.parse(buffer.slice(0, i)));
  });
  socket.on('error', reject);
  socket.once('connect', () => socket.write(`${JSON.stringify({ id: 'r1', version: 1, method, params, token })}\n`));
});

describe('minimal extension endpoint', () => {
  it('serves the code retrieval call that code_explore depends on', async () => {
    const response = await call('codeRetrieval.call', { workspace: 'D:/w', tool: 'codegraph_search', args: { query: 'x' } });
    expect(response.ok).toBe(true);
    expect(codeRetrieval.call).toHaveBeenCalledWith('D:/w', 'codegraph_search', { query: 'x' });
  });

  it('derives the permission owner from the token, not the payload', async () => {
    await call('permission.tool.evaluate', { call: { tool: 'bash' }, workspace: 'D:/spoofed' });
    expect(toolPermission.evaluate).toHaveBeenCalledWith('D:/workspace-a', { tool: 'bash' });
  });

  it('rejects an unknown token before dispatching', async () => {
    const response = await call('codeRetrieval.call', { workspace: 'D:/w', tool: 'x', args: {} }, 'bad-token');
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('UNAUTHORIZED');
    expect(codeRetrieval.call).not.toHaveBeenCalled();
  });

  it('reports retired methods instead of silently succeeding', async () => {
    for (const method of ['wiki.list', 'wiki.search', 'admin.jobs.create', 'admin.tasks.retry', 'permission.authorize']) {
      const response = await call(method, {});
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('METHOD_NOT_FOUND');
    }
    expect(codeRetrieval.call).not.toHaveBeenCalled();
    expect(toolPermission.evaluate).not.toHaveBeenCalled();
  });

  it('keeps the protocol handshake working for existing clients', async () => {
    expect(await call('system.hello', {})).toMatchObject({ ok: true, result: { version: 1 } });
    expect(await call('system.status', {})).toMatchObject({ ok: true, result: { state: 'ready' } });
  });

  it('requires workspace and tool for retrieval', async () => {
    expect((await call('codeRetrieval.call', { tool: 'x', args: {} })).error?.code).toBe('INVALID_PARAMS');
    expect((await call('codeRetrieval.call', { workspace: 'D:/w', args: {} })).error?.code).toBe('INVALID_PARAMS');
  });
});
