import { describe, expect, it } from 'vitest';
import { knowledgeActivity, knowledgeActivityKey, knowledgeErrorText, projectKnowledge } from './knowledgeProjection';
import type { RepoWikiKnowledgeSnapshot } from '../../../shared/knowledgeKernelContracts';
export function knowledgeFixture(state: RepoWikiKnowledgeSnapshot['run'] extends infer _ ? string : never = 'running'): RepoWikiKnowledgeSnapshot { return { version: 1, key: { workspaceInstanceId: 'i', portableProjectId: 'p', projectId: 'p', branch: 'main', language: 'zh', domain: 'wiki' }, content: { state: 'available', publishedCount: 4, preparedCount: 2, expectedCount: 0 }, run: { taskId: 'task', revision: 3, phase: 'generate', state: state as NonNullable<RepoWikiKnowledgeSnapshot['run']>['state'], counts: { planned: 0, prepared: 2, failed: 0, blocked: 0, published: 0 }, capabilities: { pause: true, resume: false, cancel: true, repair: false, reanalyse: false } }, action: { state: 'idle' }, admission: { state: 'ready', modelIdentity: 'model', modelDisplayName: '知识模型', planToken: 'plan' } }; }
const none = { pause: false, resume: false, cancel: false, repair: false, reanalyse: false };
describe('knowledge projection', () => {
  it('shows README preparation without exposing a page denominator', () => {
    const snapshot = knowledgeFixture(); Object.assign(snapshot.run!, { phase: 'readme' }); snapshot.run!.counts.planned = 8;
    expect(projectKnowledge(snapshot)).toMatchObject({ title: '读取 README 中', progress: undefined });
  });
  it('projects the real active set without changing publication counts and clears it after stopping', () => {
    const snapshot = knowledgeFixture();
    const activeItems = [
      { phase: 'generate', itemId: 'generate:architecture', title: '系统架构' },
      { phase: 'generate', itemId: 'generate:api', title: 'API 参考' },
      { phase: 'generate', itemId: 'generate:usage', title: '使用指南' },
    ];
    Object.assign(snapshot.run!, { activeItems }); snapshot.run!.counts.failed = 1;
    expect(projectKnowledge(snapshot)).toMatchObject({ activeItems, activeLabel: '处理中 3 篇', published: 4, prepared: 2 });
    snapshot.run!.currentItem = '陈旧项目';
    snapshot.run!.state = 'paused'; expect(projectKnowledge(snapshot)).toMatchObject({ activeItems: [], activeLabel: undefined, currentItem: undefined });
    snapshot.run!.state = 'failed'; expect(projectKnowledge(snapshot)).toMatchObject({ activeItems: [], currentItem: undefined });
  });
  it('treats an explicit empty active set as authoritative instead of falling back to a stale item', () => {
    const snapshot = knowledgeFixture(); snapshot.run!.currentItem = '陈旧项目'; Object.assign(snapshot.run!, { activeItems: [] });
    expect(projectKnowledge(snapshot).currentItem).toBeUndefined();
  });
  it('uses item units for catalogue work and preserves legacy current-item rendering', () => {
    const snapshot = knowledgeFixture(); snapshot.run!.currentItem = '系统架构';
    expect(projectKnowledge(snapshot)).toMatchObject({ activeItems: [], activeLabel: undefined });
    Object.assign(snapshot.run!, { phase: 'catalogue', activeItems: [
      { phase: 'catalogue', itemId: 'catalogue:api', title: 'API 参考' },
      { phase: 'catalogue', itemId: 'catalogue:usage', title: '使用指南' },
    ] });
    expect(projectKnowledge(snapshot)).toMatchObject({ activeLabel: '处理中 2 项', progress: undefined });
  });
  it.each(['running','failed','paused','blocked','queued'])('keeps published content independent of %s', state => { const view = projectKnowledge(knowledgeFixture(state)); expect(view.published).toBe(4); expect(view.prepared).toBe(2); expect(view.progress).toBeUndefined(); expect(view.runLabel).toBeTruthy(); });
  it('never reaches 100 before publication settles', () => { const snapshot = knowledgeFixture(); snapshot.run!.counts = { planned: 2, prepared: 2, failed: 0, blocked: 0, published: 0 }; expect(projectKnowledge(snapshot).progress).toBe(99); snapshot.run!.state = 'completed'; snapshot.run!.counts.published = 2; expect(projectKnowledge(snapshot).progress).toBe(100); });
  it('hides the total until the catalogue is frozen and then reports page progress', () => {
    const snapshot = knowledgeFixture(); snapshot.run!.phase = 'catalogue'; snapshot.run!.counts.planned = 5;
    expect(projectKnowledge(snapshot)).toMatchObject({ progress: undefined, title: '生成目录中', description: '正在生成文档目录结构' });
    snapshot.run!.phase = 'generate'; expect(projectKnowledge(snapshot)).toMatchObject({ progress: 40, title: '生成文档中', description: '正在生成，已完成 2/5（40%）' });
  });
  it('titles queued, paused and pause-requested runs by state rather than stage', () => {
    const snapshot = knowledgeFixture('queued'); expect(projectKnowledge(snapshot).title).toBe('等待生成');
    snapshot.run!.state = 'paused'; snapshot.run!.capabilities = { ...none, resume: true, cancel: true }; expect(projectKnowledge(snapshot)).toMatchObject({ title: '生成已暂停', primary: { kind: 'resume', label: '继续' }, secondary: { kind: 'cancel' } });
    snapshot.run!.state = 'pause_requested'; snapshot.run!.capabilities = none; expect(projectKnowledge(snapshot)).toMatchObject({ title: '暂停中…', primaryDisabled: true, secondary: undefined });
  });
  it('offers exactly one primary action once a run settles', () => {
    const snapshot = knowledgeFixture('completed'); expect(projectKnowledge(snapshot).primary).toEqual({ kind: 'generate', label: '更新', intent: 'update' });
    snapshot.content.publishedCount = 0; snapshot.run = null; expect(projectKnowledge(snapshot)).toMatchObject({ primary: { kind: 'generate', label: '生成' }, statusLabel: '未生成', inFlight: false });
  });
  it('routes failed runs through the server repair capability even with zero prepared pages', () => {
    const snapshot = knowledgeFixture('failed'); snapshot.run!.capabilities = { ...none, repair: true };
    expect(projectKnowledge(snapshot).primary).toEqual({ kind: 'repair', label: '重试' });
    snapshot.run!.counts.prepared = 0; snapshot.content.publishedCount = 0; expect(projectKnowledge(snapshot)).toMatchObject({ primary: { kind: 'repair', label: '重试' }, statusLabel: '生成失败', statusTone: 'failed' });
  });
  it('disables a new generation until the model is ready', () => { const snapshot = knowledgeFixture('failed'); expect(projectKnowledge(snapshot).primaryDisabled).toBe(false); snapshot.admission = { state: 'blocked' }; expect(projectKnowledge(snapshot).primaryDisabled).toBe(true); });
  it('renders no actions during a pinned publication', () => { const snapshot = knowledgeFixture(); snapshot.run!.phase = 'publish'; snapshot.run!.capabilities = none; expect(projectKnowledge(snapshot)).toMatchObject({ primary: undefined, secondary: undefined, title: '整理中' }); });
  it('translates kernel error codes instead of showing them raw', () => {
    expect(knowledgeErrorText({ code: 'E', message: 'GIT_DUBIOUS_OWNERSHIP' })).toContain('safe.directory');
    expect(knowledgeErrorText({ code: 'X', message: 'SOMETHING_NEW' })).toBe('生成失败（SOMETHING_NEW），请重试。');
    expect(knowledgeErrorText({ code: 'X', message: '模型暂不可用' })).toBe('模型暂不可用');
  });
  it('summarises only runs that still need attention for collection cards', () => {
    const running = knowledgeFixture(); running.run!.counts.planned = 4;
    expect(knowledgeActivity(running)).toMatchObject({ label: '生成中 50%', detail: '生成文档中', tone: 'running', progress: 50 });
    expect(knowledgeActivity(knowledgeFixture('blocked'))).toMatchObject({ tone: 'attention', label: '需要处理' });
    expect(knowledgeActivity(knowledgeFixture('completed'))).toBeUndefined();
    expect(knowledgeActivity(knowledgeFixture('cancelled'))).toBeUndefined();
    expect(knowledgeActivityKey('D:\\Repos\\Alpha\\')).toBe(knowledgeActivityKey('d:/repos/alpha'));
  });
  it('keeps prepared-only content as an unpublished draft', () => { const snapshot = knowledgeFixture('failed'); snapshot.content = { state: 'partial', publishedCount: 0, preparedCount: 2, expectedCount: 3 }; expect(projectKnowledge(snapshot)).toMatchObject({ hasDraft: true, statusLabel: '部分完成' }); });
});
