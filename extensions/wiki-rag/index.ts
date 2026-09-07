import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { WikiClient } from './client.js';
import { WikiSync, readWorkspaceSource } from './sync.js';
import { authorizeDesktopOperation } from '../_shared/desktop-control.js';

export default function wikiRag(pi: ExtensionAPI): void {
  const client = new WikiClient();
  const sync = new WikiSync(client);
  pi.registerTool({
    name: 'wiki_search', label: 'Wiki Search', description: 'Search Wiki libraries explicitly associated with the current project. Results provide kbId and pageId for reading.',
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 4000 }), kbId: Type.Optional(Type.String({ minLength: 1 })), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await client.request('wiki.pages.search', { workspace: ctx.cwd, query: params.query, ...(params.kbId ? { kbId: params.kbId } : {}), limit: params.limit ?? 20 });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
  pi.registerTool({
    name: 'wiki_read', label: 'Wiki Read', description: 'Read a Markdown page by the exact kbId and pageId returned by wiki_list or wiki_search. Do not guess library IDs.',
    parameters: Type.Object({ kbId: Type.String({ minLength: 1 }), pageId: Type.String({ minLength: 1, maxLength: 2000 }) }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = await client.request<{ content: string } | undefined>('wiki.pages.read', { workspace: ctx.cwd, kbId: params.kbId, pageId: params.pageId });
      return { content: [{ type: 'text', text: result ? result.content : `Wiki page not found: ${params.pageId}` }], details: result ?? { found: false } };
    },
  });
  pi.registerTool({
    name: 'wiki_list', label: 'Wiki List', description: 'List the current project’s associated Wiki libraries, or pages in one listed library when kbId is provided.',
    parameters: Type.Object({ kbId: Type.Optional(Type.String({ minLength: 1 })), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      const result = params.kbId
        ? await client.request('wiki.pages.list', { workspace: ctx.cwd, kbId: params.kbId, limit: params.limit ?? 50 })
        : await client.request('wiki.libraries.list', { workspace: ctx.cwd });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
  pi.registerTool({
    name: 'wiki_reindex', label: 'Wiki Reindex', description: 'Rebuild the original legacy workspace Wiki index without calling a model. New named libraries are managed in the application.',
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      if (signal?.aborted || ctx.signal?.aborted) return { content: [{ type: 'text', text: 'Wiki reindex cancelled.' }], details: { reindexed: false } };
      const permission = await authorizeDesktopOperation(client, {
        kind: 'filesystem.write', workspace: ctx.cwd, path: ctx.cwd, toolName: 'wiki_reindex',
      });
      if (permission.status !== 'allowed') return { content: [{ type: 'text', text: `Wiki reindex was ${permission.status} by Electron permissions.` }], details: { reindexed: false } };
      if (signal?.aborted || ctx.signal?.aborted) return { content: [{ type: 'text', text: 'Wiki reindex cancelled.' }], details: { reindexed: false } };
      const result = await client.request('wiki.reindex', { workspace: ctx.cwd });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
  pi.registerTool({
    name: 'wiki_update', label: 'Wiki Update', description: 'Generate a page only in the original legacy workspace Wiki mapping. Named libraries are read-only for Agents and edited or ingested in the application.',
    parameters: Type.Object({ page: Type.String({ minLength: 1, maxLength: 2000 }), sourcePath: Type.String({ minLength: 1, maxLength: 2000 }) }),
    async execute(_id, params, signal, _update, ctx) {
      let updateSignal = signal ?? ctx.signal;
      if (signal && ctx.signal && signal !== ctx.signal) updateSignal = AbortSignal.any([signal, ctx.signal]);
      if (updateSignal?.aborted) return updateResult(false);
      const permission = await authorizeDesktopOperation(client, {
        kind: 'filesystem.write', workspace: ctx.cwd, path: ctx.cwd, toolName: 'wiki_update',
      });
      if (permission.status !== 'allowed') {
        return { content: [{ type: 'text', text: `Wiki update was ${permission.status} by Electron permissions.` }], details: { updated: false } };
      }
      if (updateSignal?.aborted) return updateResult(false);
      const source = await readWorkspaceSource(ctx.cwd, params.sourcePath);
      const updated = await sync.update({ cwd: ctx.cwd, model: ctx.model, modelRegistry: ctx.modelRegistry, signal: updateSignal }, { page: params.page, sourcePath: params.sourcePath, source });
      return updateResult(updated);
    },
  });
}

function updateResult(updated: boolean) {
  return { content: [{ type: 'text' as const, text: updated ? 'Wiki page updated.' : 'Wiki page was not updated.' }], details: { updated } };
}
