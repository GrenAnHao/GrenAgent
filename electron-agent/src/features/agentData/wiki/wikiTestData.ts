import type { WikiAssetDetail, WikiRawSource, WikiSearchResponse } from '../../../lib/agentData';

export const wikiAsset: WikiAssetDetail = {
  wikiId: 'k',
  name: '产品',
  status: 'draft',
  dir: 'D:/app/wiki/k',
  internalStatus: null,
  syncError: null,
  pageCount: 1,
  summary: '团队说明',
  version: 1,
  lastSyncAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  sourceCount: 1,
};

export const rawSource: WikiRawSource = {
  filename: 'a.md',
  sha256: 'abc',
  size: 12,
  status: 'uploaded',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  last_modified_by: null,
  ingested_at: null,
  ingest_error: null,
};

export const wikiPage = { id: 'concepts/auth', title: '说明', type: 'concept', relPath: 'wiki/concepts/auth.md' };

export const searchResponse: WikiSearchResponse = {
  results: [{
    path: 'wiki/concepts/auth.md',
    title: '说明',
    snippet: '权限模型',
    score: 1,
    type: 'concept',
    hop: 0,
    related: [],
  }],
  links: [],
  count: 1,
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
