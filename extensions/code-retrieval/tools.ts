import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { connectCodeGraph } from './mcpClient.js';

/** Attached only to code_explore. Index presence is the per-turn hint, not a second copy here. */
export const CODEGRAPH_PROMPT_GUIDELINES = [
  'Use code_explore first for how code works, where a symbol lives, or what a change affects. Pass symbol names, file names, or a short question as query.',
  'Treat code_explore source as already read. Do not re-read those files unless the excerpt is truncated.',
] as const;

const exploreParams = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 4000,
    description: 'Symbol names, file names, or a short question. A natural-language question works; name the symbols that span a flow.',
  }),
  maxFiles: Type.Optional(Type.Number({
    minimum: 1,
    maximum: 20,
    description: 'Maximum number of files to include source from (default 12).',
  })),
});

export const CODE_GRAPH_TOOLS = [{
  name: 'code_explore',
  remote: 'codegraph_explore',
  label: 'Code Explore',
  promptSnippet: 'Explore the CodeGraph index for relevant source and call paths.',
  description: 'PRIMARY TOOL — call FIRST for almost any question or before an edit: how code works, architecture, a bug, where a symbol lives, or the symbols about to change. Returns relevant source from the CodeGraph index in one call, plus the call path. Query can be a natural-language question or a bag of symbol and file names. Prefer over grep or bash.',
  parameters: exploreParams,
}] as const;

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
      promptGuidelines: [...CODEGRAPH_PROMPT_GUIDELINES],
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
