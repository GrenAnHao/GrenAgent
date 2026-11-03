import { afterEach, describe, expect, it } from 'vitest';
import { AgentDataRuntime } from './runtime';
const runtimes: AgentDataRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) { runtime.close(); await runtime.waitClosed(); } });
describe('private KnowledgeKernel runtime route', () => {
  it('projects knowledge through the AgentData management port', async () => {
    const key = { workspaceInstanceId: 'workspace', portableProjectId: 'portable', projectId: 'project', branch: 'main', language: 'zh', domain: 'wiki' };
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', knowledge: {
      controllerEpoch: 'epoch', project: { read: async () => ({ key, root: '/project', projectId: 'project', scope: 'scope', planToken: 'plan', guardFloor: 0, content: { publishedCount: 0 }, published: { pages: {} } }) },
      bindEpoch: async () => [], activateEpoch: async () => {}, ackUsage: async () => {}, bindModel: async () => { throw new Error('MODEL_UNAVAILABLE'); },
      modelMessage: async () => { throw new Error('unexpected provider'); }, executeStage: async () => { throw new Error('unexpected stage'); }, abortStage: async () => {},
    } } as any); runtimes.push(runtime); await runtime.start();
    const snapshot = await runtime.requestAdmin<any>('admin.knowledge.snapshot', { projectId: 'project', domain: 'wiki' });
    expect(snapshot.content.publishedCount).toBe(0); expect(snapshot.run).toBeNull();
  });
});
