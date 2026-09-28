// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { createElement, type ReactElement } from 'react';
import { MemoryPanel } from './MemoryPanel';
import { agentDataApi, type ManagedMemoryRecord, type MemoryConversationDetail, type MemoryOverview, type ResourceNavigation } from '../../lib/agentData';
import { conversationRecord, deferred, memoryRecord } from './memoryTestData';
import { pi } from '../../lib/pi';
import { StrictMode } from 'react';
import { expectSelectDisplay, openSelect, pickSelectOption } from './antdSelectTestUtils';
import { mockWikiBrowser } from './wiki/wikiTestSupport';

const wrapper = ({ children }: { children: React.ReactNode }) => createElement(ConfigProvider, { theme: { token: { motion: false } } }, children);
const render = (ui: ReactElement) => rtlRender(ui, { wrapper });

const monitor = vi.hoisted(() => ({ watchedTaskVersion: 0, error: undefined as string | undefined }));
const ask = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../components/askConfirm', () => ({ useAskConfirm: () => ask }));
vi.mock('./AgentDataTaskProvider', () => ({ useAgentDataTaskMonitor: () => monitor }));
vi.mock('../../lib/agentData', () => ({ agentDataApi: { memory: { overview: vi.fn(), search: vi.fn(), list: vi.fn(), read: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), conversations: { list: vi.fn(), read: vi.fn() } } } }));
vi.mock('../../lib/pi', () => ({ pi: { listAllSessions: vi.fn().mockResolvedValue([]) } }));
vi.mock('./useProjectOptions', () => ({ useProjectOptions: () => [{ cwd: 'D:/proj/alpha', name: 'alpha' }, { cwd: 'D:/proj/beta', name: 'beta' }] }));
const record2: ManagedMemoryRecord = { ...memoryRecord, id: 'memory-2', content: '第二条记忆', source: undefined, sourceSessionId: undefined };
const row = (text = memoryRecord.content) => screen.getByRole('button', { name: new RegExp(text) });
async function openRecord() { fireEvent.click(await screen.findByRole('button', { name: new RegExp(memoryRecord.content) })); await screen.findByRole('button', { name: '编辑记忆' }); }
async function chooseMenu(label: string, item: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

describe('MemoryPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks(); monitor.watchedTaskVersion = 0; monitor.error = undefined; ask.mockResolvedValue(true);
    mockWikiBrowser();
    vi.mocked(pi.listAllSessions).mockResolvedValue([]);
    vi.mocked(agentDataApi.memory.overview).mockResolvedValue({ total: 2, byLevel: { L0: 0, L1: 2, L2: 0, L3: 0 } });
    vi.mocked(agentDataApi.memory.list).mockResolvedValue({ items: [memoryRecord, record2] });
    vi.mocked(agentDataApi.memory.read).mockResolvedValue(memoryRecord);
    vi.mocked(agentDataApi.memory.create).mockResolvedValue({ ...memoryRecord, id: 'created', scope: 'project', sourceProjectId: 'D:/proj/beta', origin: 'manual' });
    vi.mocked(agentDataApi.memory.update).mockResolvedValue({ ...memoryRecord, revision: 2 });
    vi.mocked(agentDataApi.memory.delete).mockResolvedValue(undefined);
    vi.mocked(agentDataApi.memory.conversations.list).mockResolvedValue({ items: [conversationRecord] });
    vi.mocked(agentDataApi.memory.conversations.read).mockResolvedValue(conversationRecord);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('opens an initial navigation request under StrictMode', async () => {
    render(<StrictMode><MemoryPanel navigation={{ view: 'memory', mode: 'create' }} navigationRequest={1} /></StrictMode>);
    expect(await screen.findByLabelText('记忆正文')).toBeTruthy();
  });
  it('defers targeted navigation until visible and processes each request once', async () => {
    const navigation: Extract<ResourceNavigation, { view: 'memory' }> = { view: 'memory', id: record2.id };
    vi.mocked(agentDataApi.memory.read).mockResolvedValue(record2);
    const { rerender } = render(<MemoryPanel userId="u" initialProject="D:/proj/alpha" visible={false} navigation={navigation} navigationRequest={1} />);
    expect(agentDataApi.memory.read).not.toHaveBeenCalled();
    rerender(<MemoryPanel userId="u" visible navigation={navigation} navigationRequest={1} />);
    expect((await screen.findByRole('article', { name: '记忆详情' })).textContent).toContain(record2.content);
    expect(agentDataApi.memory.read).toHaveBeenCalledWith({ userId: 'u', id: record2.id });
    expectSelectDisplay('项目范围', '全部项目');
    rerender(<MemoryPanel userId="u" navigation={{ ...navigation }} navigationRequest={1} />);
    expect(agentDataApi.memory.read).toHaveBeenCalledTimes(1);
    rerender(<MemoryPanel userId="u" navigation={navigation} navigationRequest={2} />);
    await waitFor(() => expect(agentDataApi.memory.read).toHaveBeenCalledTimes(2));
  });
  it('preserves a targeted dirty draft on cancellation and reads the replacement only after confirmation', async () => {
    const { rerender } = render(<MemoryPanel userId="u" />); await openRecord();
    fireEvent.click(screen.getByRole('button', { name: '编辑记忆' }));
    const input = screen.getByLabelText('记忆正文') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '不可丢的导航草稿' } });
    rerender(<MemoryPanel userId="u" navigation={{ view: 'memory', id: memoryRecord.id }} navigationRequest={1} />);
    expect(ask).not.toHaveBeenCalled();
    ask.mockResolvedValueOnce(false);
    const navigation = { view: 'memory' as const, id: record2.id };
    rerender(<MemoryPanel userId="u" navigation={navigation} navigationRequest={2} />);
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(input.value).toBe('不可丢的导航草稿');
    expect(agentDataApi.memory.read).not.toHaveBeenCalledWith({ userId: 'u', id: record2.id });
    vi.mocked(agentDataApi.memory.read).mockResolvedValue(record2);
    rerender(<MemoryPanel userId="u" navigation={navigation} navigationRequest={3} />);
    expect((await screen.findByRole('article', { name: '记忆详情' })).textContent).toContain(record2.content);
  });
  it('opens an unowned new draft through navigation and refuses to leave during saving', async () => {
    const pending = deferred<ManagedMemoryRecord>();
    vi.mocked(agentDataApi.memory.create).mockReturnValueOnce(pending.promise);
    const { rerender } = render(<MemoryPanel initialProject="D:/proj/alpha" navigation={{ view: 'memory', mode: 'create' }} navigationRequest={1} />);
    const input = await screen.findByLabelText('记忆正文') as HTMLTextAreaElement;
    expectSelectDisplay('归属范围', '请选择归属范围');
    fireEvent.change(input, { target: { value: '保存中的草稿' } });
    await pickSelectOption('归属范围', '全局');
    fireEvent.click(screen.getByRole('button', { name: '保存记忆' }));
    rerender(<MemoryPanel navigation={{ view: 'memory', id: record2.id }} navigationRequest={2} />);
    expect(input.value).toBe('保存中的草稿');
    expect(agentDataApi.memory.read).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ ...memoryRecord, id: 'created' }));
    expect(agentDataApi.memory.read).not.toHaveBeenCalledWith({ userId: 'local', id: record2.id });
  });
  it('does not replace an editor while its reload is pending', async () => {
    const { rerender } = render(<MemoryPanel userId="u" />); await openRecord();
    fireEvent.click(screen.getByRole('button', { name: '编辑记忆' }));
    const input = screen.getByLabelText('记忆正文') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '等待重新载入' } });
    const pending = deferred<ManagedMemoryRecord>();
    vi.mocked(agentDataApi.memory.read).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: '重新载入' }));
    await act(async () => {});
    rerender(<MemoryPanel userId="u" navigation={{ view: 'memory', id: record2.id }} navigationRequest={1} />);
    expect(input.value).toBe('等待重新载入');
    expect(agentDataApi.memory.read).not.toHaveBeenCalledWith({ userId: 'u', id: record2.id });
    await act(async () => pending.resolve({ ...memoryRecord, revision: 2 }));
    expect(screen.getByLabelText('记忆正文')).toBe(input);
  });
  it('browses recent memories with local identity and labels user-wide totals honestly', async () => {
    render(<MemoryPanel />);
    const recent = await screen.findByRole('button', { name: new RegExp(memoryRecord.content) });
    expect(recent.getAttribute('title')).toBe(memoryRecord.content);
    expect(agentDataApi.memory.list).toHaveBeenCalledWith({ userId: 'local', filter: { scope: 'all' }, level: 2, limit: 50 });
    expect(screen.getByText('2 条记忆')).toBeTruthy();
    await pickSelectOption('项目范围', '全局');
    await waitFor(() => expect(agentDataApi.memory.list).toHaveBeenLastCalledWith({ userId: 'local', filter: { scope: 'global' }, level: 2, limit: 50 }));
    expect(agentDataApi.memory.overview).toHaveBeenCalledTimes(1);
  });
  it('retains the selected project across unrelated chat changes and ignores non-project initial workspaces', async () => {
    const { rerender } = render(<MemoryPanel userId="u" initialProject="D:/temporary/works/session" />);
    await screen.findByText('2 条记忆');
    expectSelectDisplay('项目范围', '全部项目');
    await openSelect('项目范围');
    expect(screen.queryByRole('option', { name: /temporary/ })).toBeNull();
    await pickSelectOption('项目范围', 'alpha');
    rerender(<MemoryPanel userId="u" initialProject="D:/proj/beta" />);
    await waitFor(() => expect(agentDataApi.memory.list).toHaveBeenLastCalledWith({ userId: 'u', filter: { scope: 'project', projectId: 'D:/proj/alpha' }, level: 2, limit: 50 }));
  });
  it('shows conversations as read-only captures with no global memory tier or deletion', async () => {
    render(<MemoryPanel userId="u" />); await screen.findByText('2 条记忆');
    fireEvent.click(screen.getByRole('radio', { name: '对话记录' }));
    expect(screen.queryByLabelText('记忆层级')).toBeNull(); expect(screen.getByText(/对话捕获没有全局层/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(conversationRecord.snippet) }));
    await screen.findByText(/完整对话正文/);
    expect(agentDataApi.memory.conversations.read).toHaveBeenCalledWith({ userId: 'u', id: conversationRecord.id });
    expect(screen.queryByRole('button', { name: '删除记忆' })).toBeNull();
    expect(agentDataApi.memory.delete).not.toHaveBeenCalled();
  });
  it('retains the selected tail-search hit while the deferred conversation read supplies full text', async () => {
    const snippet = '尾部命中上下文：tail-only 需要保留';
    const transcript = `${'较早的无关对话。'.repeat(300)}\n用户：tail-only 需要保留\n助手：好的`;
    const pending = deferred<MemoryConversationDetail>();
    vi.mocked(agentDataApi.memory.conversations.list).mockResolvedValue({ items: [{ ...conversationRecord, snippet }] });
    vi.mocked(agentDataApi.memory.conversations.read).mockReturnValueOnce(pending.promise);
    render(<MemoryPanel userId="u" />); await screen.findByText('2 条记忆');
    fireEvent.click(screen.getByRole('radio', { name: '对话记录' }));
    fireEvent.change(screen.getByLabelText('搜索记忆'), { target: { value: 'tail-only' } });
    await waitFor(() => expect(agentDataApi.memory.conversations.list).toHaveBeenLastCalledWith({ userId: 'u', filter: { scope: 'all' }, query: 'tail-only', limit: 50 }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(snippet) }));
    expect(screen.getByText('正在读取详情…')).toBeTruthy();
    await act(async () => pending.resolve({ ...conversationRecord, snippet: transcript.slice(0, 1200), transcript }));
    const detail = within(screen.getByRole('article', { name: '对话记录详情' }));
    expect(detail.getByText(snippet)).toBeTruthy();
    expect(detail.getByText(/用户：tail-only/).textContent).toBe(transcript);
  });
  it('keeps selection and full detail while loading another page', async () => {
    vi.mocked(agentDataApi.memory.list).mockResolvedValueOnce({ items: [memoryRecord], nextCursor: 'next' }).mockResolvedValueOnce({ items: [record2] });
    render(<MemoryPanel userId="u" />); await openRecord();
    fireEvent.click(screen.getByRole('button', { name: '加载更多' })); await screen.findByRole('button', { name: /第二条记忆/ });
    expect(screen.getByRole('article', { name: '记忆详情' })).toBeTruthy();
    expect(row().getAttribute('aria-pressed')).toBe('true');
  });
  it('distinguishes first-load failure from empty data and keeps previous detail on refresh errors', async () => {
    vi.mocked(agentDataApi.memory.list).mockRejectedValueOnce(new Error('list unavailable'));
    const { rerender } = render(<MemoryPanel userId="u" />);
    await screen.findByText(/list unavailable/); expect(screen.queryByText('暂无记忆')).toBeNull();
    expect(screen.getByText('记忆列表尚未读取成功')).toBeTruthy();
    rerender(<MemoryPanel userId="u" refreshToken={1} />); await openRecord();
    vi.mocked(agentDataApi.memory.read).mockRejectedValueOnce(new Error('detail unavailable'));
    monitor.watchedTaskVersion++; rerender(<MemoryPanel userId="u" refreshToken={1} />);
    await screen.findByText(/detail unavailable/);
    expect(screen.getByRole('article', { name: '记忆详情' }).textContent).toContain(memoryRecord.content);
  });
  it('does not show an empty detail or old record when its initial read fails', async () => {
    vi.mocked(agentDataApi.memory.read).mockRejectedValueOnce(new Error('cannot read detail'));
    render(<MemoryPanel userId="u" />);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(memoryRecord.content) }));
    await screen.findByText(/cannot read detail/);
    expect(screen.getByText('详情尚未读取成功')).toBeTruthy();
    expect(screen.queryByRole('article', { name: '记忆详情' })).toBeNull();
  });
  it.each(['resolve', 'reject'] as const)('ignores stale detail %s after selecting another record', async (settlement) => {
    const pending = deferred<ManagedMemoryRecord>(); vi.mocked(agentDataApi.memory.read).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(record2);
    render(<MemoryPanel userId="u" />);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(memoryRecord.content) })); fireEvent.click(row('第二条记忆'));
    await screen.findByRole('article', { name: '记忆详情' });
    await act(async () => { if (settlement === 'reject') pending.reject(new Error('old failed')); else pending.resolve({ ...memoryRecord, content: '迟到的旧正文' }); });
    expect(screen.queryByText(/old failed/)).toBeNull();
    expect(screen.getByRole('article', { name: '记忆详情' }).textContent).toContain('第二条记忆');
  });
  it('does not let an old user deletion clear a newer user detail', async () => {
    const pending = deferred<void>(); vi.mocked(agentDataApi.memory.delete).mockReturnValueOnce(pending.promise);
    const { rerender } = render(<MemoryPanel userId="user-a" />); await openRecord();
    await chooseMenu('记忆更多操作', '删除记忆');
    await act(async () => {});
    rerender(<MemoryPanel userId="user-b" />); await openRecord();
    await act(async () => pending.resolve());
    expect(screen.getByRole('article', { name: '记忆详情' })).toBeTruthy();
    expect(row().getAttribute('aria-pressed')).toBe('true');
    expect(agentDataApi.memory.read).toHaveBeenLastCalledWith({ userId: 'user-b', id: memoryRecord.id });
    expect(screen.queryByText(/来源对话记录未改动/)).toBeNull();
  });
  it('refreshes only when visible after terminal events and does not overwrite a dirty editor', async () => {
    const { rerender } = render(<MemoryPanel userId="u" />); await openRecord();
    fireEvent.click(screen.getByRole('button', { name: '编辑记忆' }));
    fireEvent.change(screen.getByLabelText('记忆正文'), { target: { value: '不能覆盖的草稿' } });
    const before = vi.mocked(agentDataApi.memory.list).mock.calls.length;
    rerender(<MemoryPanel userId="u" visible={false} />); monitor.watchedTaskVersion++;
    rerender(<MemoryPanel userId="u" visible={false} />);
    expect(agentDataApi.memory.list).toHaveBeenCalledTimes(before);
    vi.mocked(agentDataApi.memory.read).mockResolvedValue({ ...memoryRecord, revision: 3, content: '后台更新' });
    rerender(<MemoryPanel userId="u" visible />);
    await waitFor(() => expect(agentDataApi.memory.list).toHaveBeenCalledTimes(before + 1));
    expect((screen.getByLabelText('记忆正文') as HTMLTextAreaElement).value).toBe('不能覆盖的草稿');
    expect(screen.getByText(/数据已更新/)).toBeTruthy();
  });
  it('ignores hidden overview results and preserves prior user data if resumed refresh fails', async () => {
    const { rerender } = render(<MemoryPanel userId="u" />); await screen.findByText('2 条记忆');
    rerender(<MemoryPanel userId="u" visible={false} />);
    const pending = deferred<MemoryOverview>(); vi.mocked(agentDataApi.memory.overview).mockReturnValueOnce(pending.promise);
    rerender(<MemoryPanel userId="u" visible />); rerender(<MemoryPanel userId="u" visible={false} />);
    await act(async () => pending.resolve({ total: 99, byLevel: { L0: 99, L1: 0, L2: 0, L3: 0 } }));
    expect(screen.getByText('2 条记忆')).toBeTruthy();
    vi.mocked(agentDataApi.memory.overview).mockRejectedValueOnce(new Error('overview refresh failed'));
    rerender(<MemoryPanel userId="u" visible />); await screen.findByText(/overview refresh failed/);
    expect(screen.getByText('2 条记忆')).toBeTruthy();
  });
  it('retains deletion failures, freezes navigation, deletes stable ids, and restores adjacent focus after commit', async () => {
    const pending = deferred<void>();
    render(<MemoryPanel userId="u" />); await openRecord();
    vi.mocked(agentDataApi.memory.delete).mockRejectedValueOnce(new Error('delete unavailable'));
    await chooseMenu('记忆更多操作', '删除记忆'); await screen.findByText(/delete unavailable/);
    expect(screen.getByRole('article', { name: '记忆详情' })).toBeTruthy();
    vi.mocked(agentDataApi.memory.delete).mockReturnValueOnce(pending.promise);
    vi.mocked(agentDataApi.memory.list).mockResolvedValue({ items: [record2] });
    await chooseMenu('记忆更多操作', '删除记忆');
    await act(async () => {});
    expect((screen.getByRole('button', { name: '返回记忆列表' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(row('第二条记忆'));
    expect(agentDataApi.memory.read).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
    await waitFor(() => expect(document.activeElement).toBe(row('第二条记忆')));
    expect(agentDataApi.memory.delete).toHaveBeenLastCalledWith({ userId: 'u' }, memoryRecord.id);
    expect(screen.queryByRole('article', { name: '记忆详情' })).toBeNull();
    expect(screen.getByText(/来源对话记录未改动/)).toBeTruthy();
  });
  it('restores the initiating trigger only after editor and detail close commits', async () => {
    render(<MemoryPanel userId="u" />); await openRecord();
    const edit = screen.getByRole('button', { name: '编辑记忆' }); edit.focus(); fireEvent.click(edit);
    fireEvent.click(screen.getByRole('button', { name: '关闭编辑' }));
    await act(async () => {});
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '编辑记忆' }));
    fireEvent.click(screen.getByRole('button', { name: '返回记忆列表' }));
    expect(document.activeElement).toBe(row());
  });
  it('does not append a newly saved record outside the active ownership filter', async () => {
    render(<MemoryPanel userId="u" />); await screen.findByText('2 条记忆');
    vi.mocked(agentDataApi.memory.create).mockResolvedValue({ ...memoryRecord, id: 'created', level: 2, scope: 'project', sourceProjectId: 'D:/proj/beta', origin: 'manual' });
    await pickSelectOption('项目范围', '全局');
    fireEvent.click(screen.getByRole('button', { name: '新增记忆' }));
    fireEvent.change(screen.getByLabelText('记忆正文'), { target: { value: '其它项目记忆' } });
    await pickSelectOption('归属范围', 'beta');
    fireEvent.click(screen.getByRole('button', { name: '保存记忆' }));
    await screen.findByText(/已保存，但当前筛选不包含这条记忆/);
    expect(screen.queryByRole('button', { name: /其它项目记忆/ })).toBeNull();
  });
  it('preserves a dirty draft but clears the valid selection and disables writes after background NOT_FOUND', async () => {
    const { rerender } = render(<MemoryPanel userId="u" />); await openRecord();
    fireEvent.click(screen.getByRole('button', { name: '编辑记忆' }));
    fireEvent.change(screen.getByLabelText('记忆正文'), { target: { value: '外部删除后可复制的草稿' } });
    vi.mocked(agentDataApi.memory.read).mockRejectedValueOnce({ code: 'NOT_FOUND' });
    monitor.watchedTaskVersion++; rerender(<MemoryPanel userId="u" />);
    await screen.findByText(/记录已被外部删除/);
    expect((screen.getByLabelText('记忆正文') as HTMLTextAreaElement).value).toBe('外部删除后可复制的草稿');
    expect((screen.getByRole('button', { name: '保存记忆' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '关闭编辑' }));
    expect(screen.queryByRole('article', { name: '记忆详情' })).toBeNull();
  });
  it('shows task monitoring failures without clearing loaded rows or dirty edits', async () => {
    const { rerender } = render(<MemoryPanel userId="u" />); await openRecord();
    fireEvent.click(screen.getByRole('button', { name: '编辑记忆' }));
    fireEvent.change(screen.getByLabelText('记忆正文'), { target: { value: '监控失败时仍保留的草稿' } });
    monitor.error = 'jobs connection lost'; rerender(<MemoryPanel userId="u" />);
    expect(screen.getByRole('alert').textContent).toBe('任务状态读取失败：jobs connection lost');
    expect(row()).toBeTruthy();
    expect((screen.getByLabelText('记忆正文') as HTMLTextAreaElement).value).toBe('监控失败时仍保留的草稿');
    expect(screen.getByText('2 条记忆')).toBeTruthy();
    monitor.error = undefined; rerender(<MemoryPanel userId="u" />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText('记忆正文') as HTMLTextAreaElement).value).toBe('监控失败时仍保留的草稿');
  });
  it('does not disable an unrelated new draft when an old selected record read reports deletion', async () => {
    const pending = deferred<ManagedMemoryRecord>();
    const { rerender } = render(<MemoryPanel userId="u" />); await openRecord();
    vi.mocked(agentDataApi.memory.read).mockReturnValueOnce(pending.promise);
    monitor.watchedTaskVersion++; rerender(<MemoryPanel userId="u" />);
    fireEvent.click(screen.getByRole('button', { name: '新增记忆' }));
    fireEvent.change(screen.getByLabelText('记忆正文'), { target: { value: '与原记录无关的新草稿' } });
    await pickSelectOption('归属范围', '全局');
    screen.getByLabelText('记忆正文').focus();
    await act(async () => pending.reject({ code: 'NOT_FOUND' }));
    expect((screen.getByLabelText('记忆正文') as HTMLTextAreaElement).value).toBe('与原记录无关的新草稿');
    expect(document.activeElement).toBe(screen.getByLabelText('记忆正文'));
    expect((screen.getByRole('button', { name: '保存记忆' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '保存记忆' }));
    await waitFor(() => expect(agentDataApi.memory.create).toHaveBeenCalledWith({ userId: 'u', draft: { content: '与原记录无关的新草稿', level: 2, owner: { scope: 'global' } } }));
  });
  it('groups by level with totals and requests the chosen level from the server', async () => {
    vi.mocked(agentDataApi.memory.overview).mockResolvedValue({ total: 7, byLevel: { L0: 1, L1: 2, L2: 3, L3: 1 } });
    render(<MemoryPanel userId="u" />);
    expect(await screen.findByText('7 条记忆')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /L2.*3/ })).toBeChecked();
    await waitFor(() => expect(agentDataApi.memory.list).toHaveBeenLastCalledWith({ userId: 'u', filter: { scope: 'all' }, level: 2, limit: 50 }));
    fireEvent.click(screen.getByRole('radio', { name: /L3/ }));
    await waitFor(() => expect(agentDataApi.memory.list).toHaveBeenLastCalledWith({ userId: 'u', filter: { scope: 'all' }, level: 3, limit: 50 }));
    expect(screen.queryByRole('radio', { name: '全部' })).toBeNull();
  });
  it('moves to the saved level and says so', async () => {
    vi.mocked(agentDataApi.memory.list).mockResolvedValue({ items: [{ ...memoryRecord, level: 2 }] });
    vi.mocked(agentDataApi.memory.read).mockResolvedValue({ ...memoryRecord, level: 2 });
    vi.mocked(agentDataApi.memory.update).mockResolvedValue({ ...memoryRecord, level: 3, revision: 2 });
    render(<MemoryPanel userId="u" />); await openRecord();
    fireEvent.click(screen.getByRole('button', { name: '编辑记忆' }));
    await pickSelectOption('编辑记忆层级', /L3/);
    fireEvent.click(screen.getByRole('button', { name: '保存记忆' }));
    expect(await screen.findByText('已保存，已移到 L3')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /L3/ })).toBeChecked();
  });
  it('creates in a modal defaulting to the current group level', async () => {
    render(<MemoryPanel userId="u" />); await screen.findByText('2 条记忆');
    fireEvent.click(screen.getByRole('radio', { name: /L3/ }));
    fireEvent.click(screen.getByRole('button', { name: '新增记忆' }));
    const dialog = await screen.findByRole('dialog');
    expectSelectDisplay('编辑记忆层级', /L3/);
    fireEvent.change(within(dialog).getByLabelText('记忆正文'), { target: { value: '新条目' } });
    await pickSelectOption('归属范围', '全局');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存记忆' }));
    await waitFor(() => expect(agentDataApi.memory.create).toHaveBeenCalledWith({ userId: 'u', draft: { content: '新条目', level: 3, owner: { scope: 'global' } } }));
  });
  it('reloads its list when the shared refresh token changes', async () => {
    const { rerender } = render(<MemoryPanel userId="u" refreshToken={0} />);
    await waitFor(() => expect(agentDataApi.memory.list).toHaveBeenCalledTimes(1));
    rerender(<MemoryPanel userId="u" refreshToken={1} />);
    await waitFor(() => expect(agentDataApi.memory.list).toHaveBeenCalledTimes(2));
  });
  it('merges the moved-level and out-of-filter notices when a cross-level save leaves the project filter', async () => {
    vi.mocked(agentDataApi.memory.create).mockResolvedValue({ ...memoryRecord, id: 'created', level: 1, scope: 'global', origin: 'manual' });
    render(<MemoryPanel userId="u" />); await screen.findByText('2 条记忆');
    await pickSelectOption('项目范围', 'alpha');
    fireEvent.click(screen.getByRole('button', { name: '新增记忆' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('记忆正文'), { target: { value: '跨层记忆' } });
    await pickSelectOption('归属范围', '全局');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存记忆' }));
    expect(await screen.findByText('已保存，已移到 L1，但当前筛选不包含这条记忆。')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /L1/ })).toBeChecked();
  });
});
