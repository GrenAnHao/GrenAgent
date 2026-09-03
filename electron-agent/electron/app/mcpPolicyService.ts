import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PiProcessCommand } from '../pi/manager';
import type { PermissionManager, PermissionAuthorization, PermissionProfileName } from './permissionManager';

interface ProbeOptions {
  env: Record<string, string>;
}

type ProbeRunner = (command: string, args: string[], options: ProbeOptions) => Promise<{ stdout: string; stderr: string }>;

export interface McpPolicyServiceOptions {
  piCommand?: PiProcessCommand;
  piPackageDir?: string;
  run?: ProbeRunner;
  permissionManager?: Pick<PermissionManager, 'authorize'>;
  publish?: (event: { id: string; type: 'mcp.state_changed'; timestamp: number; data: unknown }) => void;
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
    this.publish({ action: 'policy.changed' });
  }

  async evaluateCall(workspace: string, toolName: string, args: Record<string, unknown>, profile: PermissionProfileName = 'interactive'): Promise<PermissionAuthorization> {
    const result = await this.authorize({ kind: 'mcp.call', workspace, toolName, args }, profile);
    this.publish({ action: 'tool.called', workspace, toolName, status: result.status });
    return result;
  }

  async probe(configJson: string): Promise<string> {
    const command = this.options.piCommand;
    const piPackageDir = this.options.piPackageDir;
    if (!command || !piPackageDir) throw new Error('Pi runtime is not configured for MCP probing');
    try {
      const result = await (this.options.run ?? runProbe)(command.command, probeArgs(command), {
        env: { PI_PACKAGE_DIR: piPackageDir, MCP_PROBE_CONFIG: configJson },
      });
      return result.stdout.trim();
    } catch (error) {
      const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
        ? (error as { stderr: string }).stderr.trim()
        : '';
      throw new Error(stderr || `MCP probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async readOptional(filename: string): Promise<string> {
    try {
      return await readFile(join(this.piDir, filename), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  private authorize(operation: Record<string, unknown>, profile: PermissionProfileName): Promise<PermissionAuthorization> {
    return this.options.permissionManager?.authorize(operation, profile) ?? Promise.resolve({ status: 'allowed', decision: 'allow' });
  }

  private publish(data: unknown): void {
    this.options.publish?.({ id: randomUUID(), type: 'mcp.state_changed', timestamp: Date.now(), data });
  }
}

function probeArgs(command: PiProcessCommand): string[] {
  return command.args[0]?.startsWith('--') ? ['probe-mcp'] : [command.args[0], 'probe-mcp'];
}

const execFileAsync = promisify(execFile);

async function runProbe(command: string, args: string[], options: ProbeOptions): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    env: { ...process.env, ...options.env },
    windowsHide: true,
    timeout: 30_000,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}
