import { MemoryClient } from '../memory/client.js';

export interface CodeGraphClient { callTool(name: string, args: Record<string, unknown>): Promise<unknown>; close(): Promise<void> }

export async function connectCodeGraph(workspace: string, timeoutMs = 65_000): Promise<CodeGraphClient> {
  if (!workspace.trim()) throw new Error('workspace is required');
  const client = new MemoryClient(timeoutMs);
  return {
    callTool: (tool, args) => client.request('codeRetrieval.call', { workspace, tool, args }),
    // Each RPC owns its socket; the CodeGraph process belongs to the main-process pool.
    close: async () => {},
  };
}
