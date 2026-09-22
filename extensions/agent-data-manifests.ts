// AgentData clients use the desktop-owned loopback endpoint, not arbitrary network or process access.
export const memoryManifest = {
  id: 'memory', version: '0.1.0', apiVersion: '1',
  capabilities: ['agent', 'tool', 'event-subscriber'],
  permissions: { filesystem: 'none', network: 'allowlist', process: 'none' },
} as const;

// Agent surface: wiki_list, wiki_read, wiki_search only (no wiki_update / wiki_reindex).
export const wikiRagManifest = {
  id: 'wiki-rag', version: '0.1.0', apiVersion: '1',
  capabilities: ['tool'],
  permissions: { filesystem: 'workspace-read', network: 'allowlist', process: 'none' },
} as const;

export const codeRetrievalManifest = {
  id: 'code-retrieval', version: '0.1.0', apiVersion: '1',
  capabilities: ['tool'],
  permissions: { filesystem: 'workspace-read', network: 'allowlist', process: 'none' },
} as const;
