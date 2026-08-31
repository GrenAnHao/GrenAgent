import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { WikiClient } from './client.js';
export default function wikiRag(pi: ExtensionAPI): void { const client = new WikiClient(); pi.registerTool({ name: 'wiki_search', label: 'Wiki Search', description: 'Search local workspace Wiki.', parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 4000 }), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }), async execute(_id, params, _signal, _update, ctx) { const result = await client.request('wiki.search', { workspace: ctx.cwd, query: params.query, limit: params.limit ?? 20 }); return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }; } }); }
