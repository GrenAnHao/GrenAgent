import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface CodeGraphClient { callTool(name: string, args: Record<string, unknown>): Promise<unknown>; close(): Promise<void> }

export async function connectCodeGraph(workspace: string, timeoutMs = 60_000): Promise<CodeGraphClient> {
  if (!workspace.trim()) throw new Error('workspace is required');
  if (!existsSync(join(workspace, '.codegraph'))) throw new Error('CodeGraph index is not initialized; run `codegraph init` in this workspace.');
  const configured = process.env.GREN_CODEGRAPH_COMMAND?.trim();
  const command = configured ? configured.split(/\s+/) : ['codegraph', 'serve', '--mcp', '--path', workspace];
  const transport = new StdioClientTransport({ command: command[0], args: configured ? [...command.slice(1), '--path', workspace] : command.slice(1), cwd: workspace, env: { ...process.env, GREN_CODEGRAPH_WORKSPACE: workspace } });
  const client = new Client({ name: 'grenagent-code-retrieval', version: '0.1.0' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([client.connect(transport), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CodeGraph connection timed out after ${timeoutMs}ms`)), timeoutMs); })]);
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  } finally { if (timer) clearTimeout(timer); }
  return { callTool: async (name, args) => client.callTool({ name, arguments: args }), close: () => client.close() };
}
