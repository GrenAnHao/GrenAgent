import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoWikiWorkspace } from './RepoWikiWorkspace';
import { useModuleStore } from '../../stores/moduleStore';
import { useSessionStore } from '../../store';
import { createRepoWikiRuntimeFixture, fixtureWorkspace, scratchFixtureWorkspace } from './testing/runtimeFixture';

let fixture: ReturnType<typeof createRepoWikiRuntimeFixture>;
beforeEach(() => {
  fixture = createRepoWikiRuntimeFixture();
  window.gren = fixture.bridge as typeof window.gren;
  useModuleStore.setState({ activeModule: 'repoWiki' });
  useSessionStore.setState({ activeWorkspace: fixtureWorkspace, registeredProjects: fixture.snapshot().openedRoots, draftConversationCwd: null, draftConversationId: null, activeSessionPath: null });
});
afterEach(() => { cleanup(); delete window.gren; vi.restoreAllMocks(); });

async function openReader() {
  render(<RepoWikiWorkspace />);
  await screen.findByRole('region', { name: 'Repo Wiki 概览' });
  fireEvent.click(await screen.findByRole('treeitem', { name: /项目概览/ }));
  await screen.findByText('真实阅读正文。');
}

describe('real embedded Repo Wiki', () => {
  it('waits for the requested project before selecting a task language namespace', async () => {
    const navigation = { workspace: 'D:\\Projects\\Next', language: 'en', request: 1 };
    render(<RepoWikiWorkspace navigation={navigation} />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    expect(fixture.calls.some((call) => call.command === 'repoWiki_activate' && call.args.language === 'en')).toBe(false);
    act(() => useSessionStore.setState({ activeWorkspace: navigation.workspace }));
    await waitFor(() => expect(fixture.snapshot().activeProjectId).toBe('next-en'));
    expect(fixture.calls.filter((call) => call.command === 'repoWiki_activate' && call.args.language === 'en').every((call) => call.args.workspace === navigation.workspace)).toBe(true);
  });

  it('applies a task namespace only when the reading page becomes visible', async () => {
    const navigation = { workspace: fixtureWorkspace, language: 'en', request: 2 };
    const view = render(<RepoWikiWorkspace visible={false} navigation={navigation} />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    expect(fixture.snapshot().activeProjectId).toBe('forest');
    view.rerender(<RepoWikiWorkspace visible navigation={navigation} />);
    await waitFor(() => expect(fixture.snapshot().activeProjectId).toBe('forest-en'));
  });
  it('uses the AgentData shell and exposes the durable task entry while reading', async () => {
    const openTasks = vi.fn();
    const view = render(<RepoWikiWorkspace integrated onOpenTasks={openTasks} />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    expect(view.container.querySelector('.panel-titlebar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看生成任务' }));
    expect(openTasks).toHaveBeenCalledOnce();
  });
  it('shows the kernel page progress of a live run and no legacy progress banner', async () => {
    render(<RepoWikiWorkspace />);
    await screen.findByTestId('knowledge-overview');
    act(() => fixture.emit({ id: 'half-run', target: 'wiki', status: 'running', progress: 50 }));
    expect(await screen.findByText('正在生成，已完成 10/20（50%）')).toBeInTheDocument();
    expect(document.querySelector('.generation-banner, .progress-number')).toBeNull();
  });
  it('shows seven host summaries and the current project shell before any backend responds', () => {
    const roots = [fixtureWorkspace, ...Array.from({ length: 6 }, (_, i) => `D:\\Projects\\Host-${i + 1}`)];
    useSessionStore.setState({ registeredProjects: roots });
    fixture.holdNext('repoWiki_activate');
    fixture.holdNext('repoWiki_hostProjects');
    render(<RepoWikiWorkspace />);
    expect(screen.getByRole('region', { name: '当前宿主项目' })).toHaveTextContent('Forest');
    expect(screen.getAllByRole('button', { name: /^打开项目 / })).toHaveLength(7);
    expect(screen.queryByText('正在同步宿主项目…')).toBeNull();
    expect(fixture.snapshot().wikiProjects).toHaveLength(0);
  });

  it('retains loaded renderer summaries while the host registry snapshot is pending', async () => {
    const roots = [fixtureWorkspace, ...Array.from({ length: 6 }, (_, i) => `D:\\Projects\\Host-${i + 1}`)];
    useSessionStore.setState({ registeredProjects: roots });
    fixture.setOpenedRoots([]); fixture.setHostSnapshotState('pending');
    render(<RepoWikiWorkspace />);
    await act(async () => {});
    expect(screen.getByRole('region', { name: '当前宿主项目' })).toHaveTextContent('Forest');
    expect(screen.getAllByRole('button', { name: /^打开项目 / })).toHaveLength(7);
    expect(fixture.snapshot().wikiProjects).toHaveLength(0);
  });

  it('keeps project selection available while hydration never returns and ignores its stale result', async () => {
    const roots = [fixtureWorkspace, 'D:\\Projects\\Next', ...Array.from({ length: 5 }, (_, i) => `D:\\Projects\\Host-${i + 1}`)];
    fixture.setOpenedRoots(roots);
    useSessionStore.setState({ registeredProjects: roots });
    const held = fixture.holdNext('repoWiki_hydrate');
    render(<RepoWikiWorkspace />);
    await held.started;
    expect(screen.getByRole('region', { name: '当前宿主项目' })).toHaveTextContent('Forest');
    expect(screen.getAllByRole('button', { name: /^打开项目 / })).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: '打开项目 Next' }));
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    expect(useSessionStore.getState().activeWorkspace).toBe('D:\\Projects\\Next');
    await act(async () => held.release());
    expect(screen.getByRole('region', { name: 'Repo Wiki 概览' })).toBeInTheDocument();
    expect(fixture.snapshot().activeProjectId).toBe('next');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not release a live context when another renderer host project is registered', async () => {
    render(<RepoWikiWorkspace />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    const token = fixture.snapshot().contextId;
    act(() => useSessionStore.setState({ registeredProjects: [...fixture.snapshot().openedRoots, 'D:\\Projects\\Added'] }));
    await act(async () => {});
    expect(fixture.snapshot().contextId).toBe(token);
    expect(fixture.calls.filter((call) => call.command === 'repoWiki_release')).toHaveLength(0);
  });

  it('does not release a same-path remount token when its previous activation reply arrives late', async () => {
    const oldActivation = fixture.holdNext('repoWiki_activate');
    const first = render(<RepoWikiWorkspace />);
    await oldActivation.started;
    first.unmount();
    render(<RepoWikiWorkspace />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    const liveToken = fixture.snapshot().contextId;
    await act(async () => oldActivation.release());
    expect(fixture.snapshot().contextId).toBe(liveToken);
    fireEvent.click(screen.getByRole('treeitem', { name: /项目概览/ }));
    await screen.findByText('真实阅读正文。');
  });

  it('detaches a running view without cancelling its job and ignores stale cleanup after a new workspace binds', async () => {
    const first = render(<RepoWikiWorkspace />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    const tokenA = fixture.snapshot().contextId;
    act(() => fixture.emit({ id: 'background', status: 'running', target: 'wiki' }));
    const oldRelease = fixture.holdNext('repoWiki_release');
    first.unmount();
    await oldRelease.started;
    expect(fixture.calls.find((call) => call.command === 'repoWiki_release')?.args).toEqual({ __repoWikiContext: tokenA });
    act(() => useSessionStore.setState({ activeWorkspace: 'D:\\Projects\\Next' }));
    render(<RepoWikiWorkspace />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    const tokenB = fixture.snapshot().contextId;
    expect(tokenB).not.toBe(tokenA);
    await act(async () => oldRelease.release());
    expect(fixture.snapshot().contextId).toBe(tokenB);
    cleanup();
    await waitFor(() => expect(fixture.snapshot().contextId).toBe(''));
    act(() => useSessionStore.setState({ activeWorkspace: fixtureWorkspace }));
    render(<RepoWikiWorkspace />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    await screen.findByRole('button', { name: '暂停' });
    expect(fixture.snapshot().run).toMatchObject({ id: 'background', status: 'running' });
  });

  it('polls only the kernel snapshot of a live run, serially, without legacy run, project or changes reads', async () => {
    render(<RepoWikiWorkspace />);
    await screen.findByTestId('knowledge-overview');
    const reads = (pattern: RegExp) => fixture.calls.filter((call) => pattern.test(call.command)).length;
    const initialReads = reads(/repoWiki_(project|changes)$/);
    const held = fixture.holdNext('repoWiki_knowledge');
    act(() => fixture.emit({ id: 'poll-run', status: 'running', target: 'wiki' }));
    await held.started;
    const knowledgeReads = reads(/repoWiki_knowledge$/);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2700)); });
    expect(reads(/repoWiki_knowledge$/)).toBe(knowledgeReads);
    expect(reads(/repoWiki_(project|changes)$/)).toBe(initialReads);
    act(() => fixture.emit({ id: 'poll-run', status: 'completed', target: 'wiki' }));
    await act(async () => held.release());
    const settledReads = reads(/repoWiki_knowledge$/);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2700)); });
    expect(reads(/repoWiki_knowledge$/)).toBe(settledReads);
    expect(reads(/repoWiki_run$/)).toBe(0);
  });

  it('activates the host workspace automatically without a manual create or provider setup', async () => {
    const initialHash = window.location.hash;
    render(<RepoWikiWorkspace />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    expect(screen.queryByRole('button', { name: '连接仓库' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '生成模式' })).toBeNull();
    expect(screen.getByText('使用系统知识调度')).toBeInTheDocument();
    expect(fixture.calls.some((call) => call.command === 'repoWiki_create')).toBe(false);
    expect(fixture.calls.find((call) => call.command === 'repoWiki_activate')?.args).toEqual({ workspace: fixtureWorkspace, view_id: expect.any(String) });
    expect(window.location.hash).toBe(initialHash);
  });

  it('retries delayed host registration and imports every opened host project without generating', async () => {
    fixture.setOpenedRoots([]);
    render(<RepoWikiWorkspace />);
    await screen.findByRole('region', { name: '当前宿主项目' });
    expect(screen.queryByRole('region', { name: 'Repo Wiki 概览' })).toBeNull();
    act(() => fixture.setOpenedRoots([fixtureWorkspace, 'D:\\Projects\\Next']));
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    fireEvent.click(screen.getByRole('button', { name: '返回 Repo Wiki 项目集合' }));
    await screen.findByRole('button', { name: '打开项目 Forest' });
    expect(screen.getByRole('button', { name: '打开项目 Next' })).toBeInTheDocument();
    expect(fixture.calls.filter((call) => /repoWiki_(create|generate)/.test(call.command))).toHaveLength(0);
  });

  it('uses the host workspace/session switch for a collection selection', async () => {
    render(<RepoWikiWorkspace />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    fireEvent.click(screen.getByRole('button', { name: '返回 Repo Wiki 项目集合' }));
    fireEvent.click(await screen.findByRole('button', { name: '打开项目 Next' }));
    await waitFor(() => expect(useSessionStore.getState().activeWorkspace).toBe('D:\\Projects\\Next'));
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    expect(fixture.calls.find((call) => call.command === 'open_workspace')?.args).toEqual({ workspace: 'D:\\Projects\\Next' });
    expect(useSessionStore.getState().draftConversationCwd).toBe('D:\\Projects\\Next');
  });

  it('isolates the old workspace immediately and restores its unsaved page when returning', async () => {
    await openReader();
    fireEvent.click(screen.getByRole('button', { name: '编辑文档' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown 编辑器' }), { target: { value: '# 跨项目草稿' } });
    const oldContext = fixture.snapshot().contextId;
    act(() => useSessionStore.setState({ activeWorkspace: 'D:\\Projects\\Next' }));
    expect(screen.queryByRole('textbox', { name: 'Markdown 编辑器' })).toBeNull();
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    act(() => fixture.emitRaw({ context_id: oldContext, project_id: 'next', sequence: 100, run: { id: 'obsolete', status: 'running', message: '旧项目事件' } }));
    expect(screen.queryByText(/旧项目事件/)).toBeNull();
    act(() => useSessionStore.setState({ activeWorkspace: fixtureWorkspace }));
    expect(await screen.findByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('# 跨项目草稿');
  });

  it('protects a cached draft when leaving the module from a different workspace', async () => {
    await openReader();
    fireEvent.click(screen.getByRole('button', { name: '编辑文档' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown 编辑器' }), { target: { value: '# 不可丢弃' } });
    act(() => useSessionStore.setState({ activeWorkspace: 'D:\\Projects\\Next' }));
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: '关闭 Repo Wiki，返回对话' }));
    expect(useModuleStore.getState().activeModule).toBe('repoWiki');
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('rejects old child instances, repeated sequences and retired generation runs', async () => {
    render(<RepoWikiWorkspace />);
    await screen.findByTestId('knowledge-overview');
    const live = (id: string, item: string, revision: number) => { const next = fixture.knowledgeFor({ id, status: 'running', target: 'wiki', current_page: item }); next.run!.revision = revision; return next; };
    const current = live('run-old', '当前进度', 2);
    fixture.setKnowledge(current);
    act(() => fixture.emitRaw({ instance_id: 'instance-1', sequence: 10, run: { id: 'run-old', status: 'running' }, knowledge: current }));
    await screen.findByText('当前进度');
    act(() => fixture.emitRaw({ instance_id: 'instance-1', sequence: 9, run: { id: 'run-old', status: 'running' }, knowledge: live('run-old', '重复序号', 3) }));
    act(() => fixture.emitRaw({ instance_id: 'instance-obsolete', sequence: 11, run: { id: 'run-old', status: 'running' }, knowledge: live('run-old', '旧进程', 4) }));
    expect(screen.getByText('当前进度')).toBeInTheDocument();
    const next = live('run-new', '新任务进度', 1);
    fixture.setKnowledge(next);
    act(() => fixture.emitRaw({ instance_id: 'instance-1', sequence: 11, run: { id: 'run-new', status: 'running' }, knowledge: next }));
    await screen.findByText('新任务进度');
    act(() => fixture.emitRaw({ instance_id: 'instance-1', sequence: 12, run: { id: 'run-old', status: 'running' }, knowledge: live('run-old', '退役任务进度', 9) }));
    expect(screen.getByText('新任务进度')).toBeInTheDocument();
    expect(screen.queryByText(/重复序号|旧进程|退役任务进度/)).toBeNull();
  });

  it('binds a newly submitted generation to its returned run id', async () => {
    render(<RepoWikiWorkspace />);
    await screen.findByTestId('knowledge-overview');
    act(() => fixture.emit({ id: 'previous-run', status: 'failed', target: 'wiki', error: '上次任务失败' }));
    expect(await screen.findByText('上次任务失败')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    fireEvent.click(screen.getByRole('button', { name: '确认并生成' }));
    await screen.findByRole('button', { name: '暂停' });
    act(() => fixture.emitRaw({ instance_id: 'fixture-child', sequence: 99, run: { id: 'previous-run', status: 'running' }, knowledge: fixture.knowledgeFor({ id: 'previous-run', status: 'running', target: 'wiki', current_page: '旧任务倒灌' }) }));
    expect(screen.queryAllByText(/旧任务倒灌/)).toHaveLength(0);
  });

  it('keeps an edit while the same workspace registry is temporarily unavailable', async () => {
    await openReader();
    fireEvent.click(screen.getByRole('button', { name: '编辑文档' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown 编辑器' }), { target: { value: '# 等待登记的草稿' } });
    act(() => fixture.setOpenedRoots([]));
    await screen.findByRole('region', { name: '当前宿主项目' });
    act(() => fixture.setOpenedRoots([fixtureWorkspace]));
    expect(await screen.findByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('# 等待登记的草稿');
  });

  it('requires a new host context handshake before accepting a restarted child', async () => {
    render(<RepoWikiWorkspace />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    act(() => fixture.emit({ id: 'old-run', status: 'running', target: 'wiki', current_page: '重启前任务' }));
    await screen.findByText('重启前任务');
    const pending = fixture.holdNext('repoWiki_activate');
    let previous = '';
    act(() => { previous = fixture.restartChild(); });
    await pending.started;
    act(() => fixture.emitRaw({ context_id: previous, instance_id: 'fixture-child', sequence: 6, run: { id: 'old-run', status: 'running' }, knowledge: fixture.knowledgeFor({ id: 'old-run', status: 'running', target: 'wiki', current_page: '旧进程延迟事件' }) }));
    expect(screen.queryAllByText(/旧进程延迟事件/)).toHaveLength(0);
    await screen.findByRole('region', { name: '当前宿主项目' });
    await act(async () => pending.release());
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    act(() => fixture.emit({ id: 'resumed-run', status: 'running', target: 'wiki', current_page: '重启后任务' }));
    expect(await screen.findByText('重启后任务')).toBeInTheDocument();
    act(() => fixture.emitRaw({ context_id: previous, instance_id: 'fixture-child', sequence: 100, run: { id: 'old-run', status: 'completed' }, knowledge: fixture.knowledgeFor({ id: 'old-run', status: 'completed', target: 'wiki' }) }));
    expect(screen.getByText('重启后任务')).toBeInTheDocument();
  });

  it('treats a trusted nonempty scratch workspace as empty without activation retries', async () => {
    fixture.setOpenedRoots([]);
    useSessionStore.setState({ activeWorkspace: scratchFixtureWorkspace });
    render(<RepoWikiWorkspace />);
    await screen.findByText('还没有打开的项目');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
    expect(fixture.calls.filter((call) => call.command === 'repoWiki_activate')).toHaveLength(1);
    expect(screen.queryByText('正在同步宿主项目…')).toBeNull();
  });

  it('returns from the collection to the currently authorized language namespace', async () => {
    render(<RepoWikiWorkspace />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    fireEvent.click(await screen.findByRole('radio', { name: 'English' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'English' })).toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: '返回 Repo Wiki 项目集合' }));
    fireEvent.click(await screen.findByRole('button', { name: '打开项目 Forest' }));
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    expect(await screen.findByRole('radio', { name: 'English' })).toBeChecked();
    expect(fixture.snapshot().activeProjectId).toBe('forest-en');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('selects language through lightweight host activation without creating a namespace first', async () => {
    render(<RepoWikiWorkspace />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    const previousToken = fixture.snapshot().contextId;
    fireEvent.click(await screen.findByRole('radio', { name: 'English' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'English' })).toBeChecked());
    expect(fixture.calls.filter((call) => call.command === 'repoWiki_activate').at(-1)?.args).toMatchObject({ workspace: fixtureWorkspace, language: 'en' });
    expect(fixture.calls.filter((call) => call.command === 'repoWiki_create')).toHaveLength(0);
    expect(fixture.snapshot().contextId).not.toBe(previousToken);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('preserves a dirty page during an immediately resolved same-workspace child restart', async () => {
    await openReader();
    fireEvent.click(screen.getByRole('button', { name: '编辑文档' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown 编辑器' }), { target: { value: '# 重启中的草稿' } });
    await act(async () => { fixture.restartChild(); });
    expect(await screen.findByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('# 重启中的草稿');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText('重启中的草稿');
    expect(fixture.calls.filter((call) => call.command === 'repoWiki_edit').at(-1)?.args).toMatchObject({ markdown: '# 重启中的草稿', __repoWikiContext: fixture.snapshot().contextId });
  });

  it('requires an explicit retry after the host child recovery budget is exhausted', async () => {
    fixture.setActivationFailure(true);
    render(<RepoWikiWorkspace />);
    await screen.findByText('Repo Wiki 子进程恢复次数已耗尽');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
    expect(fixture.calls.filter((call) => call.command === 'repoWiki_activate')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '重试 Repo Wiki' }));
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    expect(fixture.calls.filter((call) => call.command === 'repoWiki_activate').at(-1)?.args).toMatchObject({ workspace: fixtureWorkspace, retry: true });
  });

  it('shows a host empty state when no projects are opened', async () => {
    fixture.setOpenedRoots([]);
    useSessionStore.setState({ activeWorkspace: '' });
    render(<RepoWikiWorkspace />);
    await screen.findByText('还没有打开的项目');
    expect(screen.queryByRole('button', { name: '连接仓库' })).toBeNull();
  });

  it('keeps a failed-save draft, blocks module close until accepted, and saves with the source revision', async () => {
    await openReader();
    fireEvent.click(screen.getByRole('button', { name: '编辑文档' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown 编辑器' }), { target: { value: '# 人工修订\n\n保留草稿' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: '关闭 Repo Wiki，返回对话' }));
    expect(useModuleStore.getState().activeModule).toBe('repoWiki');
    expect(confirm).toHaveBeenCalledOnce();
    fixture.setSaveError(true);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('# 人工修订\n\n保留草稿');
    fixture.setSaveError(false);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText('保留草稿');
    expect(fixture.calls.filter((call) => call.command === 'repoWiki_edit').at(-1)?.args).toMatchObject({ project_id: 'forest', slug: 'overview', markdown: '# 人工修订\n\n保留草稿', expected_revision: 1 });
    fireEvent.click(screen.getByRole('button', { name: '关闭 Repo Wiki，返回对话' }));
    expect(useModuleStore.getState().activeModule).toBe('chat');
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('keeps the original page storage token and draft when an external edit conflicts', async () => {
    await openReader();
    fireEvent.click(screen.getByRole('button', { name: '编辑文档' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown 编辑器' }), { target: { value: '# 冲突中的原始草稿' } });
    fixture.externalPageEdit();
    act(() => fixture.emit({ id: 'refresh', status: 'completed', target: 'wiki' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText('文档已在外部修改，请保留草稿后重新读取');
    expect(screen.getByRole('textbox', { name: 'Markdown 编辑器' })).toHaveValue('# 冲突中的原始草稿');
    expect(fixture.calls.filter((call) => call.command === 'repoWiki_edit').at(-1)?.args.expected_storage_token).toBe('a'.repeat(64));
  });

  it('submits the plan token captured when its editor opened after metadata refreshes', async () => {
    render(<RepoWikiWorkspace />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    fireEvent.click(screen.getByRole('button', { name: '更多 Wiki 操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Wiki 计划/ }));
    fixture.externalPlanEdit();
    act(() => fixture.emit({ id: 'refresh', status: 'completed', target: 'wiki' }));
    fireEvent.click(screen.getByRole('button', { name: '保存计划' }));
    await screen.findByText('计划已在外部修改，请保留草稿后重新读取');
    expect(fixture.calls.filter((call) => call.command === 'repoWiki_plan').at(-1)?.args.expected_plan_storage_token).toBe('b'.repeat(64));
    expect(screen.getByRole('dialog', { name: 'Wiki 计划' })).toBeInTheDocument();
  });

  it('keeps Wiki and cards separate, opens source evidence, and releases subscriptions on each unmount', async () => {
    await openReader();
    fireEvent.click(screen.getByRole('button', { name: /源码依据/ }));
    await screen.findByText('export const forest = true;');
    fireEvent.click(screen.getByRole('button', { name: '关闭源码' }));
    fireEvent.click(screen.getByRole('button', { name: '源码' }));
    expect(screen.getByLabelText('Markdown 源码')).toHaveTextContent('真实阅读正文。');
    fireEvent.click(screen.getByRole('button', { name: '知识卡片' }));
    await screen.findByRole('region', { name: '知识卡片概览' });
    fireEvent.click(screen.getByRole('button', { name: /进程边界/ }));
    await screen.findByText('卡片正文与 Wiki 分开保存。');
    cleanup();
    await waitFor(() => expect(fixture.snapshot().listeners).toBe(0));
    render(<RepoWikiWorkspace />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    expect(fixture.snapshot()).toMatchObject({ subscribeCount: 2, releaseCount: 1, listeners: 1 });
    cleanup();
    expect(fixture.snapshot()).toMatchObject({ releaseCount: 2, listeners: 0 });
  });

  it('uses the configured real model with explicit source consent, cancellation, failure and retry', async () => {
    render(<RepoWikiWorkspace />);
    await screen.findByRole('region', { name: 'Repo Wiki 概览' });
    fireEvent.click(await screen.findByRole('button', { name: '更新' }));
    expect(fixture.calls.some((call) => call.command === 'repoWiki_generate')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '确认并生成' }));
    await screen.findByRole('button', { name: '暂停' });
    expect(fixture.calls.find((call) => call.command === 'repoWiki_generate')?.args).toMatchObject({ provider: 'real', target: 'wiki', confirm_external: true, intent: 'update', expected_model_identity: 'fixture/knowledge@digest' });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(fixture.calls.find((call) => call.command === 'repoWiki_action')?.args).toMatchObject({ action: 'cancel', task_id: 'run-1' }));
    expect(await screen.findByText('上次生成已取消，已发布的内容保持不变。')).toBeInTheDocument();
    act(() => fixture.emit({ id: 'run-1', status: 'failed', target: 'wiki', error: '模型暂不可用' }));
    expect(await screen.findByText('模型暂不可用')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    fireEvent.click(screen.getByRole('button', { name: '确认并生成' }));
    await waitFor(() => expect(fixture.calls.filter((call) => call.command === 'repoWiki_generate')).toHaveLength(2));
    expect(screen.queryByText('离线规则演示')).toBeNull();
  });
});
