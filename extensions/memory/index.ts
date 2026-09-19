import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { MemoryClient } from './client.js';
import { LayeredMemoryCapture } from './capture.js';
import { buildMemoryContext } from './context.js';
import { scopeFromContext } from './store.js';
import { getConfig } from '../_shared/runtime-config.js';
import { toolPrompt } from '../_shared/toolPrompt.js';

const MEMORY_PROMPT_GUIDELINES = [
  'Use memory_search or conversation_search for local layered memory and captured conversations; pass query and optional limit.',
];

function automaticMemoryEnabled(): boolean {
  return process.env.PI_IS_SUBAGENT !== '1' && process.env.PI_SYSTEM_WORKER !== '1' && getConfig('PI_SYSTEM_WORKER') !== '1';
}

export default function memory(pi: ExtensionAPI) {
  const client = new MemoryClient();
  const capture = new LayeredMemoryCapture(client);
  pi.on('before_agent_start', async (event, ctx) => {
    if (!automaticMemoryEnabled() || getConfig('MEMORY_AUTO_INJECT') === '0') return undefined;
    const query = event.prompt.trim(); if (!query) return undefined;
    try {
      const result = await client.request<Array<{ level: number; content: string }>>('memory.search', { ...scopeFromContext(ctx), query, limit: 8 });
      const content = buildMemoryContext(result); return content ? { message: { customType: 'memory', content, display: false } } : undefined;
    } catch { return undefined; }
  });
  pi.on('agent_end', async (_event, ctx) => {
    if (!automaticMemoryEnabled() || getConfig('MEMORY_AUTO_CAPTURE') === '0') return;
    // SDK agent_end.messages contains only this run; the active branch contains
    // the cumulative conversation without messages from abandoned branches.
    const messages = ctx.sessionManager.getBranch().filter((entry) => entry.type === 'message').map((entry) => entry.message);
    await capture.enqueue({ ...scopeFromContext(ctx), model: ctx.model, modelRegistry: ctx.modelRegistry, signal: ctx.signal, extract: getConfig('MEMORY_EXTRACT') !== '0' }, messages).catch(() => {});
  });
  pi.registerTool({
    name: 'memory_search', label: 'Memory Search', description: 'Search local layered memory.',
    ...toolPrompt('Search local layered memory.', MEMORY_PROMPT_GUIDELINES),
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }),
    async execute(_id, params, _signal, _update, ctx) { const result = await client.request('memory.search', { ...scopeFromContext(ctx), query: params.query, limit: params.limit ?? 20 }); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; },
  });
  pi.registerTool({
    name: 'conversation_search', label: 'Conversation Search', description: 'Search captured local conversations and return matching text snippets with their sources.',
    ...toolPrompt('Search captured local conversations.'),
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }),
    async execute(_id, params, _signal, _update, ctx) { const result = await client.request('memory.conversations.search', { ...scopeFromContext(ctx), query: params.query, limit: params.limit ?? 20 }); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; },
  });
}
