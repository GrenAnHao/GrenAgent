import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { connectCodeGraph } from './mcpClient.js';

const queryParams = Type.Object({ query: Type.String({ minLength: 1, maxLength: 4000 }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) });
const file = Type.Optional(Type.String({ minLength: 1, maxLength: 2000 }));
const symbolParams = Type.Object({ symbol: Type.String({ minLength: 1, maxLength: 1000 }), file, limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })), depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })) });
const nodeParams = Type.Object({
  symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })), file,
  includeCode: Type.Optional(Type.Boolean()), symbolsOnly: Type.Optional(Type.Boolean()),
  offset: Type.Optional(Type.Number({ minimum: 1 })), line: Type.Optional(Type.Number({ minimum: 1 })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2000 })), depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
});
const filesParams = Type.Object({ path: Type.Optional(Type.String({ maxLength: 2000 })), pattern: Type.Optional(Type.String({ maxLength: 1000 })) });

export function registerCodeGraphTools(pi: ExtensionAPI): void {
  const call = async (workspace: string, name: string, args: Record<string, unknown>) => { const client = await connectCodeGraph(workspace); try { return await client.callTool(name, args); } finally { await client.close(); } };
  pi.registerTool({ name: 'code_search', label: 'Code Search', description: 'Search the workspace CodeGraph index.', parameters: queryParams, async execute(_id, params, _signal, _update, ctx) { return toolResult(await call(ctx.cwd, 'codegraph_search', params)); } });
  pi.registerTool({ name: 'code_explore', label: 'Code Explore', description: 'Explore relevant files and symbols in CodeGraph.', parameters: queryParams, async execute(_id, params, _signal, _update, ctx) { return toolResult(await call(ctx.cwd, 'codegraph_explore', params)); } });
  for (const [name, remote] of [['code_callers', 'codegraph_callers'], ['code_callees', 'codegraph_callees'], ['code_impact', 'codegraph_impact'], ['code_node', 'codegraph_node'], ['code_files', 'codegraph_files']] as const) {
    let parameters: typeof symbolParams | typeof filesParams | typeof nodeParams = symbolParams;
    if (name === 'code_files') parameters = filesParams;
    if (name === 'code_node') parameters = nodeParams;
    pi.registerTool({ name, label: name.replace('_', ' '), description: `Query CodeGraph ${remote}.`, parameters, async execute(_id, params, _signal, _update, ctx) { return toolResult(await call(ctx.cwd, remote, params)); } });
  }
}

function toolResult(result: unknown) {
  const blocks = result && typeof result === 'object' ? (result as { content?: unknown }).content : undefined;
  const content = Array.isArray(blocks) ? blocks.filter((block): block is { type: 'text'; text: string } =>
    Boolean(block) && block.type === 'text' && typeof block.text === 'string') : [];
  return { content: content.length ? content : [{ type: 'text' as const, text: JSON.stringify(result) ?? '' }], details: result };
}
