import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { WikiClient } from './client.js';
import { toolPrompt } from '../_shared/toolPrompt.js';

const HOP_LIMIT = 5;

const WIKI_PROMPT_GUIDELINES = [
  'Use wiki_list, wiki_search, and wiki_read for Wiki libraries; pass wikiId and ref from list/search results, do not guess wikiId.',
];

export default function wikiRag(pi: ExtensionAPI): void {
  const client = new WikiClient();
  pi.registerTool({
    name: 'wiki_search',
    label: 'Wiki Search',
    description: 'Search one Wiki library by wikiId. Results provide path/ref values for wiki_read. Pass hop (0..5), decay, and minScore when needed.',
    ...toolPrompt('Search a Wiki library by wikiId.', WIKI_PROMPT_GUIDELINES),
    parameters: Type.Object({
      wikiId: Type.String({ minLength: 1 }),
      query: Type.String({ minLength: 1, maxLength: 4000 }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      hop: Type.Optional(Type.Number({ minimum: 0, maximum: HOP_LIMIT })),
      decay: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      minScore: Type.Optional(Type.Number({ minimum: 0 })),
    }),
    async execute(_id, params) {
      if (params.hop !== undefined && (!Number.isInteger(params.hop) || params.hop < 0 || params.hop > HOP_LIMIT)) {
        const error = `invalid hop: must be integer 0..${HOP_LIMIT}`;
        return { content: [{ type: 'text', text: error }], details: { error } };
      }
      const result = await client.request('wiki.search', {
        wikiId: params.wikiId,
        query: params.query,
        limit: params.limit ?? 20,
        ...(params.hop !== undefined ? { hop: params.hop } : {}),
        ...(params.decay !== undefined ? { decay: params.decay } : {}),
        ...(params.minScore !== undefined ? { minScore: params.minScore } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
  pi.registerTool({
    name: 'wiki_read',
    label: 'Wiki Read',
    description: 'Read Markdown by the exact wikiId and ref returned by wiki_list or wiki_search. Do not guess wikiId.',
    ...toolPrompt('Read a Wiki page by wikiId and ref.'),
    parameters: Type.Object({
      wikiId: Type.String({ minLength: 1 }),
      ref: Type.String({ minLength: 1, maxLength: 2000 }),
    }),
    async execute(_id, params) {
      const content = await client.request<string>('wiki.pageRead', { wikiId: params.wikiId, ref: params.ref });
      return { content: [{ type: 'text', text: content }], details: { content } };
    },
  });
  pi.registerTool({
    name: 'wiki_list',
    label: 'Wiki List',
    description: 'List all Wiki libraries, or list pages in one library when wikiId is provided. Use returned wikiId and ref values; do not guess wikiId.',
    ...toolPrompt('List Wiki libraries or pages in one library.'),
    parameters: Type.Object({
      wikiId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_id, params) {
      const result = params.wikiId
        ? await client.request('wiki.pageList', { wikiId: params.wikiId })
        : await client.request('wiki.list', {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}
