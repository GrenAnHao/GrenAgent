import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { connectCodeGraph } from './mcpClient.js';

const queryParams = Type.Object({ query: Type.String({ minLength: 1, maxLength: 4000 }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) });

export function registerCodeGraphTools(pi: ExtensionAPI): void {
  const call = async (workspace: string, name: string, args: Record<string, unknown>) => { const client = await connectCodeGraph(workspace); try { return await client.callTool(name, { projectPath: workspace, ...args }); } finally { await client.close(); } };
  pi.registerTool({ name: 'code_search', label: 'Code Search', description: 'Search the workspace CodeGraph index.', parameters: queryParams, async execute(_id, params, _signal, _update, ctx) { const result = await call(ctx.cwd, 'codegraph_search', params); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; } });
  pi.registerTool({ name: 'code_explore', label: 'Code Explore', description: 'Explore relevant files and symbols in CodeGraph.', parameters: queryParams, async execute(_id, params, _signal, _update, ctx) { const result = await call(ctx.cwd, 'codegraph_explore', params); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; } });
  for (const [name, remote] of [['code_callers', 'codegraph_callers'], ['code_callees', 'codegraph_callees'], ['code_impact', 'codegraph_impact'], ['code_node', 'codegraph_node'], ['code_files', 'codegraph_files']] as const) {
    const parameters = name === 'code_files' ? Type.Object({ path: Type.Optional(Type.String({ maxLength: 2000 })), pattern: Type.Optional(Type.String({ maxLength: 1000 })) }) : Type.Object({ symbol: Type.String({ minLength: 1, maxLength: 1000 }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })), depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })) });
    pi.registerTool({ name, label: name.replace('_', ' '), description: `Query CodeGraph ${remote}.`, parameters, async execute(_id, params, _signal, _update, ctx) { const result = await call(ctx.cwd, remote, params); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; } });
  }
}
