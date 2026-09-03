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

  it('passes the exact MCP config to the Pi probe command and returns stdout', async () => {
    const received: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const service = new McpPolicyService('C:/home', {
      piCommand: { command: 'C:/bin/pi.exe', args: ['--mode', 'rpc'] },
      piPackageDir: 'C:/agent',
      run: async (command, args, options) => {
        received.push({ command, args, env: options.env });
        return { stdout: '{"ok":true}', stderr: '' };
      },
    });

    await expect(service.probe('{"command":"npx"}')).resolves.toBe('{"ok":true}');
    expect(received).toEqual([{
      command: 'C:/bin/pi.exe',
      args: ['probe-mcp'],
      env: { PI_PACKAGE_DIR: 'C:/agent', MCP_PROBE_CONFIG: '{"command":"npx"}' },
    }]);
  });

  it('includes Pi stderr when the probe command fails', async () => {
    const service = new McpPolicyService('C:/home', {
      piCommand: { command: 'pi', args: [] },
      piPackageDir: 'C:/agent',
      run: async () => {
        throw Object.assign(new Error('exit 1'), { stderr: 'bad MCP config' });
      },
    });

    await expect(service.probe('{}')).rejects.toThrow('bad MCP config');
  });

  it('wraps probe timeouts without stderr into a readable error', async () => {
    const service = new McpPolicyService('C:/home', {
      piCommand: { command: 'pi', args: [] },
      piPackageDir: 'C:/agent',
      run: async () => {
        throw Object.assign(new Error('kill ETIMEDOUT'), { code: 'ERR_CHILD_PROCESS_TIMEOUT' });
      },
    });

    await expect(service.probe('{}')).rejects.toThrow('MCP probe failed: kill ETIMEDOUT');
  });

  it('audits policy changes and calls through PermissionManager and publishes MCP state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'electron-agent-mcp-'));
    directories.push(home);
    const authorize = vi.fn(async () => ({ decision: 'allow' as const, status: 'allowed' as const }));
    const publish = vi.fn();
    const service = new McpPolicyService(home, { permissionManager: { authorize }, publish });

    await service.writePolicy('{"rules":[]}');
    await expect(service.evaluateCall('C:/repo', 'mcp__server__tool', { value: 1 }, 'workspace')).resolves.toMatchObject({ status: 'allowed' });

    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mcp.policy.change' }), 'interactive');
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ kind: 'mcp.call', toolName: 'mcp__server__tool' }), 'workspace');
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'mcp.state_changed', data: expect.objectContaining({ action: 'policy.changed' }) }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'mcp.state_changed', data: expect.objectContaining({ action: 'tool.called' }) }));
  });
});
