import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { panelConnectionFingerprint, type PanelConnection } from './panel';
import { TencentDbPanelRuntime, parsePanelPort, type PanelSpawn } from './panelRuntime';

const connection: PanelConnection = {
  mode: 'remote',
  serviceId: 'service-a',
  userId: 'user-a',
  gatewayEndpoint: 'https://gateway.example',
  knowledgeEndpoint: 'https://knowledge.example/v3',
  gatewayApiKey: 'gateway-secret',
  userKey: 'user-secret',
};

function layout() {
  return {
    root: 'C:/runtime',
    node: () => 'node',
    panelEntry: () => 'C:/runtime/panel/dist/index.js',
    assertReady: () => {},
  } as never;
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.exitCode = 0;
    child.emit('close', 0);
    return true;
  });
  child.stdin.once('finish', () => child.kill());
  return child;
}

describe('TencentDB Panel runtime', () => {
  it('accepts only a non-zero TCP port without whitespace', () => {
    expect(parsePanelPort('43123')).toBe(43123);
    for (const value of ['', '0', '65536', '43123 ', '12x']) {
      expect(() => parsePanelPort(value)).toThrow();
    }
  });

  it('starts Panel with managed port and waits for health', async () => {
    const child = fakeChild();
    let spawnOptions: Parameters<PanelSpawn>[2] | undefined;
    const spawn = vi.fn<PanelSpawn>((_command, _args, options) => {
      spawnOptions = options;
      const portFile = options.env?.TDAI_PANEL_PORT_FILE;
      if (portFile) void writeFile(portFile, '43123', 'utf8');
      return child as never;
    });
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const runtime = new TencentDbPanelRuntime(layout(), { spawn, fetch: fetchImpl, startupTimeoutMs: 500 });

    await expect(runtime.ensureStarted(connection)).resolves.toBe('http://127.0.0.1:43123');
    expect(spawn).toHaveBeenCalledWith('node', ['C:/runtime/panel/dist/index.js'], expect.any(Object));
    expect(spawnOptions?.env?.TDAI_PANEL_BOOTSTRAP_SECRET).toBeTruthy();
    expect(spawnOptions?.env?.TDAI_PANEL_INSTANCES_JSON).toContain('service-a');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/__grenagent/health',
      expect.objectContaining({ headers: { 'x-tdai-panel-shared-secret': expect.any(String) } }),
    );
    await runtime.stop();
    expect(child.kill).toHaveBeenCalled();
  });

  it('restarts when the connection fingerprint changes', async () => {
    const children = [fakeChild(), fakeChild()];
    let index = 0;
    const spawn = vi.fn<PanelSpawn>((_command, _args, options) => {
      const child = children[index++];
      const portFile = options.env?.TDAI_PANEL_PORT_FILE;
      if (portFile) void writeFile(portFile, String(43123 + index), 'utf8');
      return child as never;
    });
    const runtime = new TencentDbPanelRuntime(layout(), {
      spawn,
      fetch: async () => new Response('', { status: 200 }),
      startupTimeoutMs: 500,
    });

    await runtime.ensureStarted(connection);
    await runtime.ensureStarted({ ...connection, userKey: 'changed' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(children[0].kill).toHaveBeenCalled();
    expect(panelConnectionFingerprint(connection)).not.toBe(panelConnectionFingerprint({ ...connection, userKey: 'changed' }));
  });

  it('registers a short-lived bootstrap token', async () => {
    const child = fakeChild();
    const requests: Array<[string, RequestInit | undefined]> = [];
    const spawn = vi.fn<PanelSpawn>((_command, _args, options) => {
      const portFile = options.env?.TDAI_PANEL_PORT_FILE;
      if (portFile) void writeFile(portFile, '43123', 'utf8');
      return child as never;
    });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push([url, init]);
      return new Response('', { status: 200 });
    });
    const runtime = new TencentDbPanelRuntime(layout(), { spawn, fetch: fetchImpl, startupTimeoutMs: 500 });

    await runtime.ensureStarted(connection);
    const token = await runtime.registerBootstrap(connection);
    expect(token).toMatch(/^[a-f0-9]{32}$/);
    const registration = requests.find(([url]) => url.endsWith('/__grenagent/bootstrap/register'));
    expect(registration).toBeTruthy();
    expect(registration?.[1]?.headers).toEqual(expect.objectContaining({ 'x-tdai-panel-shared-secret': expect.any(String) }));
    const body = JSON.parse(String(registration?.[1]?.body));
    expect(body.instance_id).toBe('service-a');
    expect(body.user_key).toBe('user-secret');
    await runtime.stop();
  });
});
