// AgentData clients use the desktop-owned loopback endpoint, not arbitrary network or process access.
export const codeRetrievalManifest = {
  id: 'code-retrieval', version: '0.1.0', apiVersion: '1',
  capabilities: ['tool'],
  permissions: { filesystem: 'workspace-read', network: 'allowlist', process: 'none' },
} as const;
