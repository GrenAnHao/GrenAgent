import { Type, type TSchema } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { connectCodeGraph } from './mcpClient.js';

const query = Type.String({ minLength: 1, maxLength: 4000 });
const symbol = Type.String({ minLength: 1, maxLength: 1000 });
const file = Type.Optional(Type.String({ minLength: 1, maxLength: 2000 }));
const limit = Type.Optional(Type.Number({ minimum: 1, maximum: 200 }));
const depth = Type.Optional(Type.Number({ minimum: 1, maximum: 10 }));
const strings = Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 50 }));
const bool = Type.Optional(Type.Boolean());

const searchParams = Type.Object({
  query: Type.Optional(query),
  kind: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  kinds: strings, languages: strings, includePatterns: strings, excludePatterns: strings, words: strings,
  limit, offset: Type.Optional(Type.Number({ minimum: 0, maximum: 10_000 })),
  caseSensitive: bool, excludePrefix: bool,
  mode: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
});
const exploreParams = Type.Object({
  query, maxFiles: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })), limit,
  searchLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  traversalDepth: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
  maxNodes: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  minScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  edgeKinds: strings, nodeKinds: strings, seedNames: strings,
});
const symbolParams = Type.Object({ symbol, file, limit, depth, line: Type.Optional(Type.Number({ minimum: 1 })) });
const nodeParams = Type.Object({
  symbol: Type.Optional(symbol), file, includeCode: bool, symbolsOnly: bool, includeMetrics: bool,
  offset: Type.Optional(Type.Number({ minimum: 0 })), line: Type.Optional(Type.Number({ minimum: 1 })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2000 })), depth,
});
const filesParams = Type.Object({
  path: Type.Optional(Type.String({ maxLength: 2000 })), pattern: Type.Optional(Type.String({ maxLength: 1000 })),
  format: Type.Optional(Type.String()), includeMetadata: bool, maxDepth: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
});
const pathParams = Type.Object({
  from: symbol, to: symbol, fromFile: file, toFile: file, edgeKinds: strings, limit,
});
const depsParams = Type.Object({ file: Type.String({ minLength: 1, maxLength: 2000 }), direction: Type.Optional(Type.String()) });
const traverseParams = Type.Object({
  symbol: Type.Optional(symbol), file, maxDepth: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
  depth, edgeKinds: strings, nodeKinds: strings, direction: Type.Optional(Type.String()), limit, includeStart: bool,
});
const contextParams = Type.Object({
  query: Type.Optional(query), title: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  description: Type.Optional(Type.String({ maxLength: 4000 })),
  maxNodes: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  maxCodeBlocks: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
  maxCodeBlockSize: Type.Optional(Type.Number({ minimum: 1, maximum: 20_000 })),
  includeCode: bool, format: Type.Optional(Type.String()),
  searchLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  traversalDepth: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
  minScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), limit,
});
const kindsLimit = Type.Object({ kinds: strings, limit });
const emptyParams = Type.Object({});

/** Attached only to code_explore. Index presence is the per-turn hint, not a second copy here. */
export const CODEGRAPH_PROMPT_GUIDELINES = [
  'When calling code_explore, code_search, or other listed code_* tools, pass every relevant parameter from that tool schema. Prefer code_explore first.',
] as const;

export const CODE_GRAPH_TOOLS: ReadonlyArray<{
  name: string; remote: string; label: string; description: string; promptSnippet: string; parameters: TSchema;
}> = [
  { name: 'code_search', remote: 'codegraph_search', label: 'Code Search', promptSnippet: 'Search the CodeGraph index by name, kind, language, or path pattern.', description: 'Search the workspace CodeGraph index for symbols and files. Prefer over grep or bash when looking up code. Supports kinds, languages, include/exclude patterns, pagination, and lookup modes (search/prefix/substring/kind/name/segment).', parameters: searchParams },
  { name: 'code_explore', remote: 'codegraph_explore', label: 'Code Explore', promptSnippet: 'Expand relevant CodeGraph files and call paths for a question.', description: 'Expand relevant files and call paths from the CodeGraph index. Use this first for codebase questions; prefer over grep or bash. Supports searchLimit, traversalDepth, maxNodes, minScore, edgeKinds, nodeKinds, seedNames.', parameters: exploreParams },
  { name: 'code_callers', remote: 'codegraph_callers', label: 'Code Callers', promptSnippet: 'Find callers of a CodeGraph symbol.', description: 'Find callers of a symbol in the CodeGraph index.', parameters: symbolParams },
  { name: 'code_callees', remote: 'codegraph_callees', label: 'Code Callees', promptSnippet: 'Find callees of a CodeGraph symbol.', description: 'Find callees of a symbol in the CodeGraph index.', parameters: symbolParams },
  { name: 'code_impact', remote: 'codegraph_impact', label: 'Code Impact', promptSnippet: 'Get the impact radius of a CodeGraph symbol.', description: 'Get the impact radius of a symbol in the CodeGraph index.', parameters: symbolParams },
  { name: 'code_node', remote: 'codegraph_node', label: 'Code Node', promptSnippet: 'Inspect one CodeGraph symbol or file, including source and metrics.', description: 'Inspect a CodeGraph symbol or file, including context, source, and optional metrics.', parameters: nodeParams },
  { name: 'code_files', remote: 'codegraph_files', label: 'Code Files', promptSnippet: 'List files in the CodeGraph index.', description: 'List indexed files from the CodeGraph index.', parameters: filesParams },
  { name: 'code_status', remote: 'codegraph_status', label: 'Code Status', promptSnippet: 'Read CodeGraph index stats and freshness.', description: 'Read CodeGraph index stats, freshness, frameworks, and backend info.', parameters: emptyParams },
  { name: 'code_usages', remote: 'codegraph_usages', label: 'Code Usages', promptSnippet: 'Find all usages of a CodeGraph symbol.', description: 'Find all usages of a symbol in the CodeGraph index.', parameters: symbolParams },
  { name: 'code_path', remote: 'codegraph_path', label: 'Code Path', promptSnippet: 'Find the shortest path between two CodeGraph symbols.', description: 'Find the shortest path between two symbols in the CodeGraph index.', parameters: pathParams },
  { name: 'code_hierarchy', remote: 'codegraph_hierarchy', label: 'Code Hierarchy', promptSnippet: 'Get the type hierarchy of a class or interface.', description: 'Get the type hierarchy of a class or interface.', parameters: symbolParams },
  { name: 'code_call_graph', remote: 'codegraph_call_graph', label: 'Code Call Graph', promptSnippet: 'Get the call graph around a function or method.', description: 'Get the call graph around a function or method.', parameters: symbolParams },
  { name: 'code_deps', remote: 'codegraph_deps', label: 'Code Deps', promptSnippet: 'Get file dependencies or dependents from CodeGraph.', description: 'Get file dependencies or dependents from the CodeGraph index.', parameters: depsParams },
  { name: 'code_cycles', remote: 'codegraph_cycles', label: 'Code Cycles', promptSnippet: 'Find circular file dependencies in CodeGraph.', description: 'Find circular file dependencies in the CodeGraph index.', parameters: Type.Object({ limit }) },
  { name: 'code_dead_code', remote: 'codegraph_dead_code', label: 'Code Dead Code', promptSnippet: 'Find unreferenced symbols in CodeGraph.', description: 'Find unreferenced symbols in the CodeGraph index.', parameters: kindsLimit },
  { name: 'code_metrics', remote: 'codegraph_metrics', label: 'Code Metrics', promptSnippet: 'Get complexity metrics for a CodeGraph symbol.', description: 'Get complexity metrics for a CodeGraph symbol.', parameters: symbolParams },
  { name: 'code_routes', remote: 'codegraph_routes', label: 'Code Routes', promptSnippet: 'Read the CodeGraph routing manifest.', description: 'Read the routing manifest from the CodeGraph index.', parameters: Type.Object({ limit }) },
  { name: 'code_traverse', remote: 'codegraph_traverse', label: 'Code Traverse', promptSnippet: 'Traverse the CodeGraph from a start symbol or file.', description: 'Traverse the CodeGraph from a start symbol or file.', parameters: traverseParams },
  { name: 'code_context', remote: 'codegraph_context', label: 'Code Context', promptSnippet: 'Build task context from CodeGraph search plus graph expansion.', description: 'Build task context from the CodeGraph index using search plus graph expansion.', parameters: contextParams },
  { name: 'code_changed', remote: 'codegraph_changed', label: 'Code Changed', promptSnippet: 'List files changed since the last CodeGraph index.', description: 'List files changed since the last CodeGraph index.', parameters: emptyParams },
];

export const CODE_GRAPH_AGENT_TOOLS = CODE_GRAPH_TOOLS.map((tool) => tool.name);

export function registerCodeGraphTools(pi: ExtensionAPI): void {
  const call = async (workspace: string, name: string, args: Record<string, unknown>) => {
    const client = await connectCodeGraph(workspace);
    try { return await client.callTool(name, args); } finally { await client.close(); }
  };
  for (const tool of CODE_GRAPH_TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      ...(tool.name === 'code_explore' ? { promptGuidelines: [...CODEGRAPH_PROMPT_GUIDELINES] } : {}),
      parameters: tool.parameters,
      async execute(_id, params, _signal, _update, ctx) { return toolResult(await call(ctx.cwd, tool.remote, params)); },
    });
  }
}

function toolResult(result: unknown) {
  const blocks = result && typeof result === 'object' ? (result as { content?: unknown }).content : undefined;
  const content = Array.isArray(blocks) ? blocks.filter((block): block is { type: 'text'; text: string } =>
    Boolean(block) && block.type === 'text' && typeof block.text === 'string') : [];
  return { content: content.length ? content : [{ type: 'text' as const, text: JSON.stringify(result) ?? '' }], details: result };
}
