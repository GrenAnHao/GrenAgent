/** Offline workflow fixture: production AgentData host/runtime; only CodeGraph I/O is replaced. */
import { RpcPeer } from '../../electron/agentProcess/rpcPeer';
import { createAgentDataHost } from '../../electron/agentDataProcess/host';
import type { AgentDataHostConfig } from '../../electron/agentDataProcess/contract';

const config = JSON.parse(process.env.AGENTDATA_HOST_CONFIG!) as AgentDataHostConfig;
delete process.env.AGENTDATA_HOST_CONFIG;
const peer = new RpcPeer({ send: (message) => { process.send!(message); } });
process.on('message', (message) => peer.receive(message));
const host = createAgentDataHost({
  config, peer,
  createCodeGraph: (list) => ({
    projects: () => list().map((workspace) => ({ workspace, indexed: false })),
    status: async (workspace: string) => ({ workspace, connected: false, indexed: false, sdkAvailable: true, sdkVersion: 'fixture', state: 'unavailable' as const }),
    search: async (workspace: string) => ({ workspace, available: false, results: [] }),
    call: async () => { throw new Error('CodeGraph is outside this workflow'); },
    runSync: async () => {}, cancelSync: async () => {}, close: async () => {},
  }),
});
peer.handleAll(host.methods);
peer.handle('fixture.barrier', async () => { await new Promise<void>((resolve) => setImmediate(resolve)); return { pid: process.pid }; });
peer.handle('host.shutdown', async () => {
  await host.shutdown();
  setImmediate(() => process.exit(0));
  return null;
});
process.on('disconnect', () => { void host.shutdown().finally(() => process.exit(0)); });
host.start().then(() => peer.emit('host.ready', { pid: process.pid, node: process.versions.node }), (error) => {
  console.error(error);
  process.exit(1);
});
