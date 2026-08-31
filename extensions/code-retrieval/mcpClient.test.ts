import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectCodeGraph } from './mcpClient.js';

const tempDirs: string[] = [];

function fixtureWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'codegraph-mcp-'));
  tempDirs.push(workspace);
  mkdirSync(join(workspace, '.codegraph'));
  return workspace;
}

function serverScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codegraph-server-'));
  tempDirs.push(dir);
  const path = join(dir, 'server.mjs');
  writeFileSync(path, body);
  return path;
}

afterEach(() => {
  delete process.env.GREN_CODEGRAPH_COMMAND;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('CodeGraph MCP client', () => {
  it('initializes a stdio server and forwards the real CodeGraph tool name', async () => {
    const workspace = fixtureWorkspace();
    const sdk = (relative: string) => pathToFileURL(join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm', relative)).href;
    const script = serverScript(`
      import { Server } from '${sdk('server/index.js')}';
      import { StdioServerTransport } from '${sdk('server/stdio.js')}';
      import { ListToolsRequestSchema, CallToolRequestSchema } from '${sdk('types.js')}';
      const server = new Server({ name: 'fake-codegraph', version: '1.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'codegraph_search', inputSchema: { type: 'object' } }] }));
      server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: JSON.stringify({ name: request.params.name, args: request.params.arguments }) }] }));
      await server.connect(new StdioServerTransport());
    `);
    process.env.GREN_CODEGRAPH_COMMAND = `node ${script}`;

    const client = await connectCodeGraph(workspace, 5_000);
    try {
      const result = await client.callTool('codegraph_search', { query: 'memory' }) as { content?: Array<{ text?: string }> };
      expect(JSON.parse(result.content?.[0]?.text ?? '{}')).toEqual({
        name: 'codegraph_search',
        args: { query: 'memory' },
      });
    } finally {
      await client.close();
    }
  });

  it('rejects when the MCP server does not initialize before the timeout', async () => {
    const workspace = fixtureWorkspace();
    const script = serverScript(`
      process.stdin.on('end', () => process.exit(0));
      setTimeout(() => {}, 60_000);
    `);
    process.env.GREN_CODEGRAPH_COMMAND = `node ${script}`;

    await expect(connectCodeGraph(workspace, 20)).rejects.toThrow('timed out after 20ms');
  });

  it('surfaces an MCP server process that exits before initialization', async () => {
    const workspace = fixtureWorkspace();
    const script = serverScript('process.exit(1);');
    process.env.GREN_CODEGRAPH_COMMAND = `node ${script}`;

    await expect(connectCodeGraph(workspace, 5_000)).rejects.toThrow();
  });
});
