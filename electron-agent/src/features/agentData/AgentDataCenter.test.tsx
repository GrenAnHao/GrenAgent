// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDataCenter } from './AgentDataCenter';
import { wikiAsset, rawSource } from './wiki/wikiTestData';
import { mockWikiBrowser, renderWiki as render } from './wiki/wikiTestSupport';
vi.mock('../chat/LazyMarkdown', () => ({ LazyMarkdown: ({ children }: { children: string }) => <pre>{children}</pre> }));

vi.mock('../../lib/agentData', () => ({
  agentDataApi: {
    status: vi.fn(),
    overview: vi.fn(), tasks: { list: vi.fn(), read: vi.fn(), previewRetry: vi.fn(), retry: vi.fn() },
    audits: { query: vi.fn(), export: vi.fn() }, checks: { check: vi.fn(), open: vi.fn() },
    jobs: { list: vi.fn(), get: vi.fn(), create: vi.fn(), cancel: vi.fn(), remove: vi.fn(), clear: vi.fn() },
    memory: { overview: vi.fn(), search: vi.fn(), delete: vi.fn(), list: vi.fn(), read: vi.fn(), create: vi.fn(), update: vi.fn(), conversations: { list: vi.fn(), read: vi.fn() } },
    wiki: {
      overview: vi.fn(), list: vi.fn(), read: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
      resetDraft: vi.fn(), ingest: vi.fn(), rawWrite: vi.fn(), rawRemove: vi.fn(), rawList: vi.fn(), rawRead: vi.fn(),
      writeTemplate: vi.fn(), pageWrite: vi.fn(), pageRemove: vi.fn(), pageList: vi.fn(), pageRead: vi.fn(),
      search: vi.fn(), graph: vi.fn(),
    },
    code: { projects: vi.fn(), status: vi.fn(), search: vi.fn(), call: vi.fn() },
  },
}));
vi.mock('./useProjectOptions', () => ({
  useProjectOptions: () => [{ cwd: 'D:/proj/alpha', name: 'alpha' }],
}));
import { agentDataApi } from '../../lib/agentData';

describe('AgentDataCenter', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  beforeEach(() => {
    vi.resetAllMocks();
    mockWikiBrowser();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.mocked(agentDataApi.status).mockResolvedValue({ state: 'ready', version: 1 });
    vi.mocked(agentDataApi.jobs.list).mockResolvedValue([]);
    vi.mocked(agentDataApi.overview).mockResolvedValue({ recentPages: [], recentMemories: [], errors: [] });
    vi.mocked(agentDataApi.tasks.list).mockImplementation(async () => ({ items: (await agentDataApi.jobs.list()).map((job) => ({
      ref: { source: 'user' as const, id: job.id }, key: `user:${job.id}`, label: job.kind, kind: job.kind, workspace: job.workspace, status: job.state,
      progress: job.progress, cancellationRequested: false, createdAt: job.createdAt, updatedAt: job.updatedAt, capabilities: { cancel: true, retry: false, remove: false },
    })) }));
    vi.mocked(agentDataApi.tasks.read).mockImplementation(async (ref) => { const job = await agentDataApi.jobs.get(ref.id); return job ? {
      ref, key: `${ref.source}:${ref.id}`, label: job.kind, kind: job.kind, workspace: job.workspace, status: job.state,
      progress: job.progress, cancellationRequested: false, createdAt: job.createdAt, updatedAt: job.updatedAt, capabilities: { cancel: false, retry: false, remove: false }, events: [],
    } : undefined; });
    vi.mocked(agentDataApi.audits.query).mockResolvedValue({ items: [] });
    vi.mocked(agentDataApi.checks.check).mockResolvedValue({ items: [], checkedAt: 1 });
    vi.mocked(agentDataApi.memory.overview).mockResolvedValue({ total: 248, byLevel: { L0: 120, L1: 64, L2: 48, L3: 16 } });
    vi.mocked(agentDataApi.memory.search).mockResolvedValue([]);
    vi.mocked(agentDataApi.memory.list).mockResolvedValue({ items: [] });
    vi.mocked(agentDataApi.memory.conversations.list).mockResolvedValue({ items: [] });
    vi.mocked(agentDataApi.wiki.overview).mockResolvedValue({ pages: 12, latestUpdatedAt: 100 });
    vi.mocked(agentDataApi.wiki.list).mockResolvedValue([wikiAsset]);
    vi.mocked(agentDataApi.wiki.read).mockResolvedValue(wikiAsset);
    vi.mocked(agentDataApi.wiki.rawList).mockResolvedValue([rawSource]);
    vi.mocked(agentDataApi.wiki.pageList).mockResolvedValue([]);
    vi.mocked(agentDataApi.wiki.graph).mockResolvedValue([]);
    vi.mocked(agentDataApi.wiki.ingest).mockResolvedValue({ kind: 'ok' });
    vi.mocked(agentDataApi.code.projects).mockResolvedValue([]);
    vi.mocked(agentDataApi.code.status).mockResolvedValue({ workspace: 'D:/proj/alpha', indexed: false, connected: false });
    vi.mocked(agentDataApi.code.call).mockResolvedValue({ content: [{ type: 'text', text: '[]' }] });
  });

  it('loads global memory and wiki overviews without any workspace', async () => {
    render(<AgentDataCenter userId="u" />);
    expect(await screen.findByText('248')).toBeTruthy();
    expect(agentDataApi.memory.overview).toHaveBeenCalledWith({ userId: 'u', includeOtherProjects: true });
    expect(agentDataApi.wiki.overview).toHaveBeenCalled();
    expect(agentDataApi.code.status).not.toHaveBeenCalled();
  });

  it('does not refetch when the initial workspace prop changes', async () => {
    const { rerender } = render(<AgentDataCenter userId="u" initialProject="D:/proj/alpha" />);
    await waitFor(() => expect(agentDataApi.memory.overview).toHaveBeenCalledTimes(1));

    rerender(<AgentDataCenter userId="u" initialProject="D:/proj/beta" />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agentDataApi.memory.overview).toHaveBeenCalledTimes(1);
  });

  it('switches views and surfaces runtime failures', async () => {
    render(<AgentDataCenter userId="u" />);
    expect(await screen.findByText('248')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
    expect(screen.getByTestId('memory-panel')).toBeTruthy();
  });

  it('shows runtime failures in the shared error state', async () => {
    vi.mocked(agentDataApi.status).mockRejectedValueOnce(new Error('runtime unavailable'));
    render(<AgentDataCenter userId="u" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('runtime unavailable'));
  });

  it('retains input and the panel node across tab switches and refresh', async () => {
    render(<AgentDataCenter userId="u" />);
    await screen.findByText('248');
    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
    const input = screen.getByLabelText('搜索记忆') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'dark' } });
    const panel = screen.getByRole('tabpanel', { name: 'Memory' });
    panel.scrollTop = 150;
    fireEvent.click(screen.getByRole('tab', { name: 'Wiki' }));
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '刷新 Agent 数据' }));
    await waitFor(() => expect(agentDataApi.status).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
    expect(screen.getByLabelText('搜索记忆')).toBe(input);
    expect(input.value).toBe('dark');
    expect(screen.getByRole('tabpanel', { name: 'Memory' })).toBe(panel);
    expect(panel.scrollTop).toBe(150);
  });

  it('keeps successful overview resources when a different resource fails', async () => {
    vi.mocked(agentDataApi.memory.overview).mockRejectedValueOnce(new Error('memory unavailable'));
    render(<AgentDataCenter userId="u" />);
    expect(await screen.findByText('12')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('memory unavailable');
    expect(within(screen.getByRole('button', { name: /^Memory/ })).getByText('未获取')).toBeTruthy();
  });

  it('retains the previous data after a background refresh fails', async () => {
    render(<AgentDataCenter userId="u" />);
    await screen.findByText('248');
    vi.mocked(agentDataApi.memory.overview).mockRejectedValueOnce(new Error('retry later'));
    fireEvent.click(screen.getByRole('button', { name: '刷新 Agent 数据' }));
    await screen.findByText(/retry later/);
    expect(screen.getByText('248')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
  });

  it('never reports an unknown or failed runtime as ready', async () => {
    let fail!: (error: Error) => void;
    vi.mocked(agentDataApi.status).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    render(<AgentDataCenter userId="u" />);
    expect(screen.getByTestId('agent-data-runtime').getAttribute('data-state')).toBe('unknown');
    await act(async () => fail(new Error('disconnected')));
    expect(screen.getByTestId('agent-data-runtime').getAttribute('data-state')).toBe('error');
    expect(screen.getByTestId('agent-data-runtime').textContent).toContain('连接异常');
  });

  it('does not replace new visible data with an older hidden request', async () => {
    let release!: (value: { total: number; byLevel: { L0: number; L1: number; L2: number; L3: number } }) => void;
    vi.mocked(agentDataApi.memory.overview).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const { rerender } = render(<AgentDataCenter userId="u" />);
    await waitFor(() => expect(agentDataApi.memory.overview).toHaveBeenCalledTimes(1));
    rerender(<AgentDataCenter userId="u" visible={false} />);
    vi.mocked(agentDataApi.memory.overview).mockResolvedValue({ total: 999, byLevel: { L0: 0, L1: 999, L2: 0, L3: 0 } });
    rerender(<AgentDataCenter userId="u" visible />);
    await screen.findByText('999');
    await act(async () => release({ total: 123, byLevel: { L0: 0, L1: 123, L2: 0, L3: 0 } }));
    expect(screen.getByText('999')).toBeTruthy();
    expect(screen.queryByText('123')).toBeNull();
  });

  it('starts wiki ingest from the workbench without creating a legacy job task', async () => {
    render(<AgentDataCenter userId="u" initialProject="D:/proj/alpha" />);
    await screen.findByText('248');
    fireEvent.click(screen.getByRole('tab', { name: 'Wiki' }));
    fireEvent.click(await screen.findByRole('button', { name: '打开知识库 产品' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '开始抽取' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '开始抽取' }));
    await waitFor(() => expect(agentDataApi.wiki.ingest).toHaveBeenCalledWith('k'));
    expect(agentDataApi.jobs.create).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Wiki' }).getAttribute('aria-selected')).toBe('true');
  });

  it('supports keyboard tab navigation without mounting unseen panels', async () => {
    render(<AgentDataCenter userId="u" />);
    await screen.findByText('248');
    expect(screen.queryByTestId('wiki-panel')).toBeNull();
    const overview = screen.getByRole('tab', { name: '概览' });
    overview.focus();
    fireEvent.keyDown(overview, { key: 'ArrowRight', code: 'ArrowRight' });
    const memory = screen.getByRole('tab', { name: /Memory/ });
    expect(document.activeElement).toBe(memory);
    fireEvent.keyDown(memory, { key: 'Enter', code: 'Enter' });
    expect(memory.getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('wiki-panel')).toBeNull();
  });

  it('shows task and diagnostic badges on their tabs', async () => {
    vi.mocked(agentDataApi.tasks.list).mockResolvedValue({ items: [], activeCount: 2 });
    vi.mocked(agentDataApi.overview).mockResolvedValue({ recentPages: [], recentMemories: [], errors: [], diagnostics: { actionRequired: 1, unchecked: 0 } });
    render(<AgentDataCenter userId="u" />);
    await waitFor(() => expect(within(screen.getByRole('tab', { name: /任务/ })).getByText('2')).toBeTruthy());
    expect(within(screen.getByRole('tab', { name: /审计诊断/ })).getByText('1')).toBeTruthy();
    expect(screen.queryByText(/已加载 \d+ 个任务/)).toBeNull();
  });

  it('broadcasts one refresh token to every visited panel', async () => {
    render(<AgentDataCenter userId="u" />);
    await screen.findByText('248');
    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
    await waitFor(() => expect(agentDataApi.memory.list).toHaveBeenCalled());
    const before = vi.mocked(agentDataApi.memory.list).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '刷新 Agent 数据' }));
    await waitFor(() => expect(vi.mocked(agentDataApi.memory.list).mock.calls.length).toBeGreaterThan(before));
  });
});
