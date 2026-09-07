// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pi, type SessionInfo } from '../../lib/pi';
import { MemoryDetail } from './MemoryDetail';
import { conversationRecord, deferred, memoryRecord, sourceSession } from './memoryTestData';

vi.mock('../../lib/pi', () => ({ pi: { listAllSessions: vi.fn() } }));
describe('MemoryDetail', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(pi.listAllSessions).mockResolvedValue([sourceSession]); });
  afterEach(cleanup);
  it('renders JSON as readable fields and arrays with collapsed raw JSON', async () => {
    render(<MemoryDetail value={{ kind: 'memory', record: { ...memoryRecord, content: '{"偏好":"中文","语言":["TypeScript","Rust"]}' } }} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('偏好')).toBeTruthy(); expect(screen.getByText('中文')).toBeTruthy();
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('原始 JSON').closest('details')?.open).toBe(false);
    expect(screen.getByRole('button', { name: '编辑记忆' })).toBeTruthy();
    await screen.findByText('已有来源会话');
  });
  it('preserves the exact raw JSON text including large integers, duplicate keys and formatting', async () => {
    const content = '{\n  "id": 9007199254740993, "tag":"first", "tag": "last"\n}\n';
    render(<MemoryDetail value={{ kind: 'memory', record: { ...memoryRecord, content } }} />);
    const raw = screen.getByText('原始 JSON').closest('details')?.querySelector('pre');
    expect(raw?.textContent).toBe(content);
    expect(screen.getByText('last')).toBeTruthy();
    await screen.findByText('已有来源会话');
  });
  it('renders unstructured full text and conversations without mutation controls', async () => {
    const { rerender } = render(<MemoryDetail value={{ kind: 'memory', record: { ...memoryRecord, content: '第一行\n第二行' } }} />);
    expect(screen.getByText(/第一行/).textContent).toBe('第一行\n第二行');
    rerender(<MemoryDetail value={{ kind: 'conversation', record: conversationRecord }} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText(conversationRecord.snippet)).toBeTruthy();
    expect(screen.getByText(/完整对话正文/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '编辑记忆' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除记忆' })).toBeNull();
    await screen.findByText('已有来源会话');
  });
  it('distinguishes unrecorded sources, removed sessions, and unknown source status', async () => {
    const { rerender } = render(<MemoryDetail value={{ kind: 'memory', record: { ...memoryRecord, source: undefined, sourceSessionId: undefined } }} />);
    expect(screen.getByText('未记录来源')).toBeTruthy(); expect(pi.listAllSessions).not.toHaveBeenCalled();
    vi.mocked(pi.listAllSessions).mockResolvedValueOnce([]);
    rerender(<MemoryDetail value={{ kind: 'memory', record: memoryRecord }} />);
    await screen.findByText('会话已移除');
    vi.mocked(pi.listAllSessions).mockRejectedValueOnce(new Error('offline'));
    rerender(<MemoryDetail value={{ kind: 'memory', record: { ...memoryRecord, id: 'memory-2' } }} />);
    expect((await screen.findByRole('alert')).textContent).toContain('来源状态未获取');
    expect(screen.queryByText('会话已移除')).toBeNull();
  });
  it('revalidates a session on click and only passes its real cwd and path', async () => {
    const open = vi.fn();
    render(<MemoryDetail value={{ kind: 'memory', record: memoryRecord }} onOpenSession={open} />);
    fireEvent.click(await screen.findByRole('button', { name: '打开来源会话' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(sourceSession.cwd, sourceSession.path));
    expect(pi.listAllSessions).toHaveBeenCalledTimes(2);
    vi.mocked(pi.listAllSessions).mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: '打开来源会话' }));
    await screen.findByText('会话已移除'); expect(open).toHaveBeenCalledTimes(1);
  });
  it('ignores an old record source lookup and a stale click after record changes', async () => {
    const pending = deferred<SessionInfo[]>(); const click = deferred<SessionInfo[]>(); const open = vi.fn();
    vi.mocked(pi.listAllSessions).mockReturnValueOnce(pending.promise);
    const { rerender } = render(<MemoryDetail value={{ kind: 'memory', record: { ...memoryRecord, id: 'old' } }} onOpenSession={open} />);
    rerender(<MemoryDetail value={{ kind: 'memory', record: memoryRecord }} onOpenSession={open} />);
    await screen.findByText('已有来源会话');
    await act(async () => pending.reject(new Error('stale')));
    expect(screen.queryByRole('alert')).toBeNull();
    vi.mocked(pi.listAllSessions).mockReturnValueOnce(click.promise);
    fireEvent.click(screen.getByRole('button', { name: '打开来源会话' }));
    rerender(<MemoryDetail value={{ kind: 'memory', record: { ...memoryRecord, id: 'new', source: undefined, sourceSessionId: undefined } }} onOpenSession={open} />);
    await act(async () => click.resolve([sourceSession]));
    expect(open).not.toHaveBeenCalled(); expect(screen.getByText('未记录来源')).toBeTruthy();
  });
  it('does not query hidden source sessions and discards an opening request when hidden', async () => {
    const open = vi.fn(); const pending = deferred<SessionInfo[]>();
    const { rerender } = render(<MemoryDetail visible={false} value={{ kind: 'memory', record: memoryRecord }} onOpenSession={open} />);
    expect(pi.listAllSessions).not.toHaveBeenCalled();
    rerender(<MemoryDetail visible value={{ kind: 'memory', record: memoryRecord }} onOpenSession={open} />);
    await screen.findByRole('button', { name: '打开来源会话' });
    vi.mocked(pi.listAllSessions).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: '打开来源会话' }));
    rerender(<MemoryDetail visible={false} value={{ kind: 'memory', record: memoryRecord }} onOpenSession={open} />);
    await act(async () => pending.resolve([sourceSession]));
    expect(open).not.toHaveBeenCalled();
  });
});
