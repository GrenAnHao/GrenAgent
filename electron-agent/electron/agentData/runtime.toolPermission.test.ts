import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';

const directories: string[] = [];
const runtimes: AgentDataRuntime[] = [];
const clients: AgentDataClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const runtime of runtimes.splice(0)) { runtime.close(); await runtime.waitClosed(); }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-tool-permission-'));
  directories.push(directory);
  const workspace = join(directory, 'project');
  const runtime = new AgentDataRuntime({ dataPath: join(directory, 'agent-data.db') });
  runtimes.push(runtime);
  await runtime.start();
  const client = new AgentDataClient(runtime.agentEndpoint(workspace));
  clients.push(client);
  return { client, workspace };
}

describe('permission.tool.* over the socket', () => {
  it('evaluates a call and stamps the token workspace', async () => {
    const { client, workspace } = await fixture();
    const result = await client.request<{ decision: string; auditId: string }>('permission.tool.evaluate', {
      call: {
        tool: 'bash', workspace: 'D:/not-mine', origin: 'main', preset: 'auto', command: 'ls',
        flags: { dangerousCommand: false, mutatingCommand: false, protectedPath: false, outsideWorkspace: false, network: false, mcp: false, codeExec: false, write: false },
      },
    });
    expect(result.decision).toBe('allow');
    expect(result.auditId).toBeTruthy();
    void workspace;
  });

  it('asks for a dangerous command under the auto preset', async () => {
    const { client } = await fixture();
    const result = await client.request<{ decision: string; ruleId: string }>('permission.tool.evaluate', {
      call: {
        tool: 'bash', workspace: 'x', origin: 'main', preset: 'auto', command: 'rm -rf /',
        flags: { dangerousCommand: true, mutatingCommand: true, protectedPath: false, outsideWorkspace: false, network: false, mcp: false, codeExec: false, write: false },
      },
    });
    expect(result).toMatchObject({ decision: 'ask', ruleId: 'builtin.dangerous-command' });
  });
});
