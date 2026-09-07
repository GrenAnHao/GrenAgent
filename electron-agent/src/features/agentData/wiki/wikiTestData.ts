import type { WikiDeletePreview, WikiLibraryView, WikiPage, WikiSource } from '../../../../electron/agentData/wikiContracts';

export const library: WikiLibraryView = {
  kbId: 'k', storageKey: 'kb-11111111-1111-4111-8111-111111111111', name: '产品', description: '团队说明',
  bindings: ['D:/a', 'D:/b'], revision: 1, lifecycle: 'active', epoch: 1, createdAt: 1, updatedAt: 1,
  location: 'D:/app/wiki/kb-11111111-1111-4111-8111-111111111111', sourceCount: 1, pageCount: 1,
  pendingSourceCount: 1, availability: 'available',
};
export const source: WikiSource = {
  kbId: 'k', sourceId: 's', name: 'a.md', kind: 'manual', snapshotPath: 'raw/sources/s/1-h.md',
  revision: 1, contentHash: 'source-h', lifecycle: 'active', epoch: 1, status: 'pending',
  generatedPageId: 'p', generationSuppressed: false, createdAt: 1, updatedAt: 1,
};
export const page: WikiPage = {
  kbId: 'k', pageId: 'p', title: '说明', content: '# 原文',
  path: `${library.location}/wiki/p.md`, sourceRefs: [], locked: true,
  revision: 1, contentHash: 'page-h', lifecycle: 'active', epoch: 1, updatedAt: 1,
};
export const deletePreview: WikiDeletePreview = {
  target: { kind: 'library', kbId: 'k' }, name: '产品', revision: 1, sources: 1, pages: 1, bindings: ['D:/a', 'D:/b'],
};
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
