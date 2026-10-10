import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServerConfig } from '../../../extensions/mcp/config.js';
import type { ProbeResult } from '../../../extensions/mcp/probe.js';
import type { PermissionManager, PermissionAuthorization, PermissionOperation, PermissionProfileName } from './permissionManager';

export interface McpPolicyServiceOptions {
  /**
   * 整个探测（拉起服务器、列工具、写缓存）交给别处，返回 JSON 字符串。
   * 主进程传 agent-host 子进程的实现：探测要 spawn 服务器进程，不放在主线程上。
   */
  probe?: (configJson: string) => Promise<string>;
  probeServer?: (cfg: McpServerConfig) => Promise<ProbeResult>;
  writeToolsCacheEntry?: (name: string, result: ProbeResult) => void;
  permissionManager?: Pick<PermissionManager, 'authorize'>;
}

export class McpPolicyService {
  private readonly piDir: string;

  constructor(private readonly home: string, private readonly options: McpPolicyServiceOptions = {}) {
    this.piDir = join(home, '.pi');
  }

  readPolicy(): Promise<string> {
    return this.readOptional('mcp-policy.json');
  }

  readAudit(): Promise<string> {
    return this.readOptional('mcp-audit.jsonl');
  }

  readToolsCache(): Promise<string> {
    return this.readOptional('mcp-tools-cache.json');
  }

  async writePolicy(content: string): Promise<void> {
    const authorization = await this.authorize({ kind: 'mcp.policy.change' }, 'interactive');
    if (authorization.status !== 'allowed') throw new Error(`MCP policy change ${authorization.status}`);
    await mkdir(this.piDir, { recursive: true });
    const target = join(this.piDir, 'mcp-policy.json');
    const temporary = `${target}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, target);
  }

  async evaluateCall(workspace: string, toolName: string, args: Record<string, unknown>, profile: PermissionProfileName = 'interactive'): Promise<PermissionAuthorization> {
    return this.authorize({ kind: 'mcp.call', workspace, toolName, args }, profile);
  }

  async probe(configJson: string): Promise<string> {
    if (this.options.probe) return this.options.probe(configJson);
    let cfg: McpServerConfig;
    try { cfg = JSON.parse(configJson) as McpServerConfig; }
    catch { return JSON.stringify({ ok: false, toolNames: [], error: 'invalid MCP_PROBE_CONFIG' }); }
    const probe = this.options.probeServer ?? (await import('../../../extensions/mcp/probe.js')).probeServer;
    const write = this.options.writeToolsCacheEntry ?? (await import('../../../extensions/mcp/toolsCache.js')).writeToolsCacheEntry;
    const result = await probe(cfg);
    try { write(cfg.name, result); } catch { /* 与 runProbeCli 一致：缓存失败打不得倒 stdout */ }
    return JSON.stringify(result);
  }

  private async readOptional(filename: string): Promise<string> {
    try {
      return await readFile(join(this.piDir, filename), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  private authorize(operation: PermissionOperation, profile: PermissionProfileName): Promise<PermissionAuthorization> {
    return this.options.permissionManager?.authorize(operation, profile) ?? Promise.resolve({ status: 'allowed', decision: 'allow' });
  }
}
