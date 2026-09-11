import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpPolicyService } from './mcpPolicyService';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('McpPolicyService', () => {
  it('returns an empty policy until a policy is saved, then persists exact content', async () => {
    const home = await mkdtemp(join(tmpdir(), 'electron-agent-mcp-'));
    directories.push(home);
    const service = new McpPolicyService(home);

    await expect(service.readPolicy()).resolves.toBe('');
    await service.writePolicy('{"rules":[]}');
    await expect(service.readPolicy()).resolves.toBe('{"rules":[]}');
    await expect(readFile(join(home, '.pi', 'mcp-policy.json'), 'utf8')).resolves.toBe('{"rules":[]}');
  });

  it('reads the audit and tool cache files without treating their absence as an error', async () => {
    const home = await mkdtemp(join(tmpdir(), 'electron-agent-mcp-'));
    directories.push(home);
    const service = new McpPolicyService(home);

    await expect(service.readAudit()).resolves.toBe('');
    await expect(service.readToolsCache()).resolves.toBe('');
    await mkdir(join(home, '.pi'), { recursive: true });
    await writeFile(join(home, '.pi', 'mcp-audit.jsonl'), '{"action":"allow"}\n');
    await writeFile(join(home, '.pi', 'mcp-tools-cache.json'), '{"server":{}}');

    await expect(service.readAudit()).resolves.toBe('{"action":"allow"}\n');
    await expect(service.readToolsCache()).resolves.toBe('{"server":{}}');
  });

  it('probe 调用 probeServer 并写缓存，不 spawn', async () => {
    const probeServer = vi.fn(async () => ({ ok: true, toolNames: ['mcp__s__t'] }));
    const writeCache = vi.fn();
    const spawn = vi.fn();
    const service = new McpPolicyService('C:/home', { probeServer, writeToolsCacheEntry: writeCache, run: spawn } as never);
    const out = await service.probe(JSON.stringify({ name: 's', transport: 'stdio', command: 'x', args: [] }));
    expect(JSON.parse(out)).toEqual({ ok: true, toolNames: ['mcp__s__t'] });
    expect(writeCache).toHaveBeenCalledWith('s', { ok: true, toolNames: ['mcp__s__t'] });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('非法 JSON 返回 ok:false，不调用 probeServer', async () => {
    const probeServer = vi.fn();
    const service = new McpPolicyService('C:/home', { probeServer });
    await expect(service.probe('not-json')).resolves.toBe(JSON.stringify({
      ok: false,
      toolNames: [],
      error: 'invalid MCP_PROBE_CONFIG',
    }));
    expect(probeServer).not.toHaveBeenCalled();
  });

  it('写缓存失败不影响 probe 返回值', async () => {
    const service = new McpPolicyService('C:/home', {
      probeServer: async () => ({ ok: true, toolNames: ['mcp__s__t'] }),
      writeToolsCacheEntry: () => { throw new Error('disk full'); },
    });
    await expect(service.probe(JSON.stringify({ name: 's', transport: 'stdio', command: 'x' }))).resolves.toBe(
      JSON.stringify({ ok: true, toolNames: ['mcp__s__t'] }),
    );
  });

  it('audits policy changes and calls through PermissionManager', async () => {
    const home = await mkdtemp(join(tmpdir(), 'electron-agent-mcp-'));
    directories.push(home);
    const authorize = vi.fn(async () => ({ decision: 'allow' as const, status: 'allowed' as const }));
    const service = new McpPolicyService(home, { permissionManager: { authorize } });

    await service.writePolicy('{"rules":[]}');
    await expect(service.evaluateCall('C:/repo', 'mcp__server__tool', { value: 1 }, 'workspace')).resolves.toMatchObject({ status: 'allowed' });

    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mcp.policy.change' }), 'interactive');
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mcp.call', toolName: 'mcp__server__tool' }), 'workspace');
  });
});
