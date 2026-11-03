import { ModuleRail } from '../../src/features/layout/ModuleRail';
import { ModuleContainer } from '../../src/features/workspace/ModuleContainer';
import { useModuleStore } from '../../src/stores/moduleStore';
import { useSessionStore } from '../../src/store';
import { createRepoWikiRuntimeFixture, fixtureWorkspace, nextFixtureWorkspace, scratchFixtureWorkspace } from '../../src/features/repoWiki/testing/runtimeFixture';
import { exposeActions, exposeData, installBridge, track } from '../stubs';
import type { RepoWikiKnowledgeSnapshot } from '../../shared/knowledgeKernelContracts';

const fixture = createRepoWikiRuntimeFixture(track);
fixture.enableLinkFixture();
const hostRoots = [fixtureWorkspace, nextFixtureWorkspace, ...Array.from({ length: 5 }, (_, index) => `D:\\Projects\\Host-${index + 1}`)];
fixture.setOpenedRoots(hostRoots);
const activationGate = fixture.holdNext('repoWiki_activate');
const snapshotGate = fixture.holdNext('repoWiki_hostProjects');
const coldTiming = { clickedAt: null as number | null, visibleAt: null as number | null };
document.addEventListener('click', (event) => {
  if ((event.target as Element).closest('.ant-tabs-tab[data-node-key="repoWiki"]') && coldTiming.clickedAt === null) coldTiming.clickedAt = performance.now();
}, true);
const firstFrameObserver = new MutationObserver(() => {
  if (coldTiming.clickedAt !== null && document.querySelector('[aria-label="当前宿主项目"]') && document.querySelectorAll('[aria-label^="打开项目 "]').length === 7) {
    coldTiming.visibleAt = performance.now(); firstFrameObserver.disconnect();
  }
});
firstFrameObserver.observe(document.documentElement, { childList: true, subtree: true });
installBridge(fixture.bridge as unknown as Record<string, unknown>);
useModuleStore.setState({ activeModule: 'chat' });
useSessionStore.setState({ activeWorkspace: fixtureWorkspace, registeredProjects: hostRoots });
let allowLeave = false;
let previousContext = '';
let previousInstance = '';
const kernelSnapshot = (state: NonNullable<RepoWikiKnowledgeSnapshot['run']>['state'] | null, revision = 1): RepoWikiKnowledgeSnapshot => ({ version: 1, key: { workspaceInstanceId: 'forest-instance', projectId: 'forest-en', portableProjectId: 'forest-portable', branch: 'main', language: 'en', domain: 'wiki' }, content: { state: state === 'failed' ? 'partial' : 'available', publishedCount: 1, preparedCount: state ? 2 : 0, expectedCount: 0 }, run: state ? { taskId: 'kernel-task', revision, phase: 'generate', state, currentItem: 'architecture', counts: { planned: 0, prepared: 2, failed: state === 'failed' ? 1 : 0, blocked: 0, published: 0 }, capabilities: { pause: state === 'running' || state === 'queued', resume: state === 'paused', cancel: ['running','paused','queued'].includes(state), repair: state === 'failed', reanalyse: state === 'blocked' } } : null, action: { state: 'idle' }, admission: { state: 'ready', modelIdentity: 'fixture/knowledge@digest', modelDisplayName: 'Fixture 知识模型', planToken: 'frozen-plan' } });
const concurrentTitles = ['系统架构', 'API参考与跨模块调用约束及来源范围说明'.repeat(4), '使用指南'];
window.confirm = () => { track('confirm-leave'); return allowLeave; };
exposeData({ workspace: fixtureWorkspace, nextFixtureWorkspace, scratchFixtureWorkspace, hostRoots });
exposeActions({
  kernelReadme: () => { const next = kernelSnapshot('running', 11); next.run!.phase = 'readme'; fixture.emitKnowledge(next); },
  kernelConcurrent: () => { const next = kernelSnapshot('running', 12); next.run!.counts.planned = 6; next.run!.counts.failed = 1; next.run!.activeItems = concurrentTitles.map((title, i) => ({ phase: 'generate', itemId: `generate:page-${i}`, title })); next.run!.currentItem = concurrentTitles[0]; fixture.emitKnowledge(next); },
  kernelConcurrentPaused: () => { const next = kernelSnapshot('paused', 13); next.run!.activeItems = concurrentTitles.map((title, i) => ({ phase: 'generate', itemId: `generate:page-${i}`, title })); fixture.emitKnowledge(next); },
  kernelLegacy: () => { const next = kernelSnapshot('running', 14); next.run!.currentItem = '兼容旧版单项'; fixture.emitKnowledge(next); },
  kernelEnter: () => fixture.emitKnowledge(kernelSnapshot(null)),
  kernelResponse: (state: NonNullable<RepoWikiKnowledgeSnapshot['run']>['state'], revision: number) => fixture.queueKnowledgeResponse(kernelSnapshot(state, revision)),
  kernelEvent: (state: NonNullable<RepoWikiKnowledgeSnapshot['run']>['state'], revision: number) => fixture.emitKnowledge(kernelSnapshot(state, revision)),
  kernelPin: () => { const next = kernelSnapshot('running', 10); next.run!.phase = 'publish'; next.run!.capabilities = { pause: false, resume: false, cancel: false, repair: false, reanalyse: false }; fixture.emitKnowledge(next); },
  releasePreparation: () => { activationGate.release(); snapshotGate.release(); },
  coldTiming: () => ({ ...coldTiming, elapsedMs: coldTiming.visibleAt === null || coldTiming.clickedAt === null ? null : coldTiming.visibleAt - coldTiming.clickedAt }),
  snapshot: () => ({ ...fixture.snapshot(), activeWorkspace: useSessionStore.getState().activeWorkspace }),
  restartChild: () => { previousInstance = fixture.snapshot().childInstance; previousContext = fixture.restartChild(); },
  resumeChild: () => fixture.emit({ id: 'resumed-run', target: 'wiki', status: 'running', message: '重启恢复进度', current_page: '重启恢复进度', progress: 50 }),
  staleChild: () => fixture.emitRaw({ context_id: previousContext, instance_id: previousInstance, sequence: 999, run: { id: 'obsolete-run', status: 'running', message: '旧进程延迟事件' }, knowledge: fixture.knowledgeFor({ id: 'obsolete-run', target: 'wiki', status: 'running', current_page: '旧进程延迟事件' }) }),
  finishResume: () => fixture.emit({ id: 'resumed-run', target: 'wiki', status: 'completed', progress: 100 }),
  startBackground: () => fixture.emit({ id: 'background-run', target: 'wiki', status: 'running', message: '正在生成架构文档', current_page: 'overview', progress: 50 }),
  backgroundAdvance: () => fixture.emit({ id: 'background-run', target: 'wiki', status: 'running', message: '后台继续生成架构文档', current_page: 'overview', progress: 75 }),
  advanceEnglishTask: () => fixture.emit({ id: 'run-1', target: 'wiki', status: 'running', message: '正在生成英文架构文档', current_page: 'architecture', progress: 60 }),
  failEnglishTask: () => fixture.emit({ id: 'run-1', target: 'wiki', status: 'failed', message: '英文文档生成失败', error: '模型暂不可用', current_page: 'architecture', progress: 60 }),
  exhaustBudget: () => { fixture.setActivationFailure(true); fixture.restartChild(); },
  enterScratch: () => { fixture.setOpenedRoots([]); useSessionStore.setState({ activeWorkspace: scratchFixtureWorkspace }); },
  failSave: () => fixture.setSaveError(true),
  allowSave: () => fixture.setSaveError(false),
  allowLeave: () => { allowLeave = true; },
  failRun: () => fixture.emit({ id: 'run-1', target: 'wiki', status: 'failed', error: '模型暂不可用' }),
  completeRun: () => fixture.emit({ id: 'run-1', target: 'wiki', status: 'completed', progress: 100 }),
  changeWorkspace: () => useSessionStore.setState({ activeWorkspace: nextFixtureWorkspace }),
  returnWorkspace: () => useSessionStore.setState({ activeWorkspace: fixtureWorkspace }),
});

export default function RepoWikiScenario() {
  return <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
    <ModuleRail />
    <ModuleContainer chat={<div data-testid="repo-wiki-chat" style={{ flex: 1, padding: 32 }}>对话保持挂载</div>} />
  </div>;
}
