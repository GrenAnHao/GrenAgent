import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RepoWikiWorkspace } from './RepoWikiWorkspace';
import { useSessionStore } from '../../store';
import { createRepoWikiRuntimeFixture, fixtureWorkspace } from './testing/runtimeFixture';
import type { RepoWikiKnowledgeSnapshot } from '../../../shared/knowledgeKernelContracts';
let fixture: ReturnType<typeof createRepoWikiRuntimeFixture>;
const snapshot = (): RepoWikiKnowledgeSnapshot => ({ version: 1, key: { workspaceInstanceId: 'instance', projectId: 'forest', portableProjectId: 'portable', branch: 'main', language: 'zh', domain: 'wiki' }, content: { state: 'available', publishedCount: 1, preparedCount: 2, expectedCount: 0 }, run: { taskId: 'kernel-task', revision: 3, phase: 'generate', state: 'running', counts: { planned: 0, prepared: 2, failed: 0, blocked: 0, published: 0 }, capabilities: { pause: true, resume: false, cancel: true, repair: false, reanalyse: false } }, action: { state: 'idle' }, admission: { state: 'ready', modelIdentity: 'provider/model@digest', modelDisplayName: '知识模型', planToken: 'plan' } });
beforeEach(() => { fixture = createRepoWikiRuntimeFixture(); window.gren = fixture.bridge as typeof window.gren; useSessionStore.setState({ activeWorkspace: fixtureWorkspace, registeredProjects: fixture.snapshot().openedRoots }); });
afterEach(() => { cleanup(); delete window.gren; vi.restoreAllMocks(); });
it('shows concurrent item names in the overview and removes them when the task pauses', async () => {
  const initial = snapshot(); Object.assign(initial.run!, { currentItem: '系统架构', activeItems: [
    { phase: 'generate', itemId: 'generate:architecture', title: '系统架构' },
    { phase: 'generate', itemId: 'generate:api', title: 'API 参考' },
    { phase: 'generate', itemId: 'generate:usage', title: '使用指南' },
  ] }); fixture.setKnowledge(initial); render(<RepoWikiWorkspace />);
  const region = await screen.findByTestId('knowledge-overview');
  expect(await within(region).findByText('处理中 3 篇')).toBeInTheDocument();
  fireEvent.click(within(region).getByText('处理中 3 篇'));
  expect(within(region).getByLabelText('正在处理的内容')).toHaveTextContent('系统架构API 参考使用指南');
  expect(within(region).queryByText('当前内容')).toBeNull();
  const paused = structuredClone(initial); paused.run!.revision++; paused.run!.state = 'paused';
  act(() => fixture.emitKnowledge(paused)); await within(region).findByText('生成已暂停');
  expect(within(region).queryByText('处理中 3 篇')).toBeNull();
  expect(within(region).queryByText('当前内容')).toBeNull();
});
it('does not paint an empty action strip during pinned publication', async () => {
  const pinned = snapshot(); pinned.run!.phase = 'publish'; pinned.run!.capabilities = { pause: false, resume: false, cancel: false, repair: false, reanalyse: false }; fixture.setKnowledge(pinned); render(<RepoWikiWorkspace />);
  const region = await screen.findByTestId('knowledge-overview'); expect(region).toHaveTextContent('整理中'); expect(region.querySelector('[data-knowledge-action]')).toBeNull();
  for (const button of region.querySelectorAll('button')) expect((button.textContent || button.getAttribute('aria-label') || '').trim()).not.toBe('');
});
it('shows four independent dimensions and performs server-authorized pause/resume without optimistic state', async () => {
  const initial = snapshot(); fixture.setKnowledge(initial); render(<RepoWikiWorkspace />);
  const region = await screen.findByTestId('knowledge-overview'); expect(region).toHaveTextContent('生成文档中'); expect(region).toHaveTextContent('正在生成文档内容'); expect(region).not.toHaveTextContent('待计划'); expect(region.querySelector('.rw-overview-emblem')).not.toBeNull();
  expect(region.querySelector('[data-knowledge-action="generate"]')).toBeNull(); expect(screen.getByRole('button', { name: /Repo Wiki 概览/ })).toHaveTextContent('生成中'); expect(region.querySelector('.ant-progress')).toBeNull();
  const paused = structuredClone(initial); paused.run!.revision++; paused.run!.state = 'paused'; paused.run!.capabilities = { pause: false, resume: true, cancel: true, repair: false, reanalyse: false }; fixture.queueKnowledgeResponse(paused);
  fireEvent.click(within(region).getByRole('button', { name: '暂停' })); await within(region).findByText('生成已暂停');
  expect(fixture.calls.find(call => call.command === 'repoWiki_action')?.args).toMatchObject({ action: 'pause', task_id: 'kernel-task', expected_revision: 3, request_id: expect.any(String) });
  const resumed = structuredClone(initial); resumed.run!.revision = 5; fixture.queueKnowledgeResponse(resumed); fireEvent.click(within(region).getByRole('button', { name: '继续' })); await within(region).findByText('生成文档中');
  act(() => fixture.emitKnowledge(paused)); expect(region).toHaveTextContent('生成文档中');
  fireEvent.click(screen.getByRole('treeitem', { name: /项目概览/ })); await screen.findByText('真实阅读正文。');
});
it('confirms repair with the frozen model and scope while keeping the official document', async () => {
  const failed = snapshot(); failed.run!.state = 'failed'; failed.run!.counts.failed = 1; failed.run!.capabilities = { pause: false, resume: false, cancel: false, repair: true, reanalyse: false }; fixture.setKnowledge(failed); render(<RepoWikiWorkspace />);
  fireEvent.click(await screen.findByRole('button', { name: '重试' })); const dialog = await screen.findByRole('dialog', { name: '确认修复失败项？' }); expect(dialog).toHaveTextContent('知识模型'); expect(dialog).toHaveTextContent('语言：zh；可复用 2 项，重做 1 项');
  fixture.queueKnowledgeResponse({ ...failed, run: { ...failed.run!, taskId: 'repair-task', revision: 0, state: 'queued', capabilities: { pause: true, resume: false, cancel: true, repair: false, reanalyse: false } } });
  fireEvent.click(within(dialog).getByRole('button', { name: '确认并生成' })); await waitFor(() => expect(fixture.calls.some(call => call.command === 'repoWiki_action')).toBe(true)); expect(fixture.calls.find(call => call.command === 'repoWiki_action')?.args).toMatchObject({ action: 'repair', confirm_external: true, expected_model_identity: 'provider/model@digest' });
});
it('keeps the repair confirmation bound to its original task, revision, model and plan token', async () => {
  const failed = snapshot(); failed.run!.state = 'failed'; failed.run!.capabilities.repair = true; fixture.setKnowledge(failed); render(<RepoWikiWorkspace />);
  fireEvent.click(await screen.findByRole('button', { name: '重试' })); const dialog = await screen.findByRole('dialog', { name: '确认修复失败项？' });
  const changed = structuredClone(failed); changed.run!.taskId = 'another-task'; changed.run!.revision = 7; changed.run!.counts.prepared = 9; changed.admission.modelIdentity = 'changed-model'; changed.admission.planToken = 'changed-plan'; act(() => fixture.emitKnowledge(changed));
  expect(dialog).toHaveTextContent('可复用 2 项，重做 0 项');
  fixture.queueKnowledgeResponse(changed); fireEvent.click(within(dialog).getByRole('button', { name: '确认并生成' })); await waitFor(() => expect(fixture.calls.some(call => call.command === 'repoWiki_action')).toBe(true));
  expect(fixture.calls.find(call => call.command === 'repoWiki_action')?.args).toMatchObject({ task_id: 'kernel-task', expected_revision: 3, expected_model_identity: 'provider/model@digest', expected_plan_token: 'plan' });
});
it('shows staged Markdown only in the unpublished modal and retains the formal reader', async () => {
  const failed = snapshot(); failed.run!.state = 'failed'; fixture.setKnowledge(failed); render(<RepoWikiWorkspace />);
  fireEvent.click(await screen.findByRole('button', { name: '查看未发布草稿' })); const dialog = await screen.findByRole('dialog', { name: '未发布草稿' }); expect(dialog).toHaveTextContent('这是尚未发布的阶段成果。'); expect(within(dialog).queryByRole('textbox')).toBeNull();
  fireEvent.keyDown(window, { key: 'Escape' }); fireEvent.click(screen.getByRole('treeitem', { name: /项目概览/ })); await screen.findByText('真实阅读正文。');
});
it('isolates late reads, stops while hidden, and immediately refreshes when visible again', async () => {
  const initial = snapshot(); fixture.setKnowledge(initial); const hold = fixture.holdNext('repoWiki_knowledge'); const view = render(<RepoWikiWorkspace />); await hold.started;
  const paused = structuredClone(initial); paused.run!.state = 'paused'; paused.run!.revision = 10; paused.run!.capabilities = { pause: false, resume: true, cancel: true, repair: false, reanalyse: false };
  act(() => fixture.emitKnowledge(paused)); await within(await screen.findByTestId('knowledge-overview')).findByText('生成已暂停'); await act(async () => hold.release()); expect(screen.getByTestId('knowledge-overview')).toHaveTextContent('生成已暂停');
  view.rerender(<RepoWikiWorkspace visible={false} />); const count = fixture.calls.filter(call => call.command === 'repoWiki_knowledge').length; await act(async () => { await new Promise(resolve => setTimeout(resolve, 2700)); }); expect(fixture.calls.filter(call => call.command === 'repoWiki_knowledge')).toHaveLength(count);
  view.rerender(<RepoWikiWorkspace visible />); await waitFor(() => expect(fixture.calls.filter(call => call.command === 'repoWiki_knowledge').length).toBeGreaterThan(count));
});
