import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { MemoryClient } from './client.js';
import { buildMemoryContext } from './context.js';
import { scopeFromContext } from './store.js';

export default function memory(pi: ExtensionAPI) {
  const client = new MemoryClient();
  pi.on('before_agent_start', async (event, ctx) => {
    const query = event.prompt.trim(); if (!query) return undefined;
    try {
      const result = await client.request<Array<{ level: number; content: string }>>('memory.search', { ...scopeFromContext(ctx), query, limit: 8 });
      const content = buildMemoryContext(result); return content ? { message: { customType: 'memory', content, display: false } } : undefined;
    } catch { return undefined; }
  });
  pi.registerTool({
    name: 'memory_search', label: 'Memory Search', description: 'Search local layered memory.',
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }),
    async execute(_id, params, _signal, _update, ctx) { const result = await client.request('memory.search', { ...scopeFromContext(ctx), query: params.query, limit: params.limit ?? 20 }); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; },
  });
  pi.registerTool({
    name: 'conversation_search', label: 'Conversation Search', description: 'Search local conversation memory.',
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }),
    async execute(_id, params, _signal, _update, ctx) { const result = await client.request('memory.search', { ...scopeFromContext(ctx), query: params.query, limit: params.limit ?? 20 }); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; },
  });
}
