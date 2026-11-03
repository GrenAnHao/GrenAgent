import { RepoWikiWorkspace } from '../../src/features/repoWiki/RepoWikiWorkspace';
import { useSessionStore } from '../../src/store';
import { createRepoWikiRuntimeFixture, fixtureWorkspace, nextFixtureWorkspace } from '../../src/features/repoWiki/testing/runtimeFixture';
import { exposeActions, installBridge } from '../stubs';
import type { RepoWikiKnowledgeSnapshot } from '../../shared/knowledgeKernelContracts';

const fixture = createRepoWikiRuntimeFixture();
const blocked: RepoWikiKnowledgeSnapshot = { version: 1, key: { workspaceInstanceId: 'old', projectId: 'forest', portableProjectId: 'forest', branch: 'main', language: 'zh', domain: 'wiki' }, content: { state: 'partial', publishedCount: 1, preparedCount: 9, expectedCount: 12 }, run: { taskId: 'legacy-budget', revision: 1, phase: 'generate', state: 'blocked', counts: { planned: 12, prepared: 9, failed: 1, blocked: 2, published: 0 }, capabilities: { pause: false, resume: false, cancel: false, repair: false, reanalyse: true }, error: { code: 'BUDGET_EXHAUSTED', message: '旧任务预算耗尽', retriable: true } }, action: { state: 'idle' }, admission: { state: 'ready', modelIdentity: 'fixture/model', planToken: 'old-plan' } };
fixture.setKnowledge(blocked);
installBridge(fixture.bridge as unknown as Record<string, unknown>);
useSessionStore.setState({ activeWorkspace: fixtureWorkspace, registeredProjects: [fixtureWorkspace, nextFixtureWorkspace] });
const taskIds: string[] = [];
let projectReadGate: ReturnType<typeof fixture.holdNext> | undefined;
exposeActions({ holdProjectRead: () => { projectReadGate = fixture.holdNext('repoWiki_project'); }, projectReadStarted: () => projectReadGate?.started, releaseProjectRead: () => projectReadGate?.release(), nativeRunning: () => fixture.setNativeRunning(), publishSecond: () => fixture.publishNative(true), publishNative: () => fixture.publishNative(), externalNative: () => fixture.setExternalNative(), taskIds: () => taskIds, calls: () => fixture.snapshot().calls, changeWorkspace: () => useSessionStore.setState({ activeWorkspace: nextFixtureWorkspace }), returnWorkspace: () => useSessionStore.setState({ activeWorkspace: fixtureWorkspace }), clearLegacy: () => fixture.setKnowledge(null) });
export default function RepoWikiPrimaryScenario() {
  return <div style={{ display: 'flex', height: '100vh' }}><RepoWikiWorkspace onTaskCreated={id => taskIds.push(id)} /></div>;
}
