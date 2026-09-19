// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentDataApi, type ManagedMemoryRecord } from '../../lib/agentData';
import { MemoryEditor } from './MemoryEditor';
import { deferred, memoryRecord } from './memoryTestData';
import { expectSelectDisplay, openSelect, pickSelectOption } from './antdSelectTestUtils';

vi.mock('../../lib/agentData', () => ({ agentDataApi: { memory: { create: vi.fn(), update: vi.fn(), read: vi.fn() } } }));
const projects = [{ cwd: 'D:/proj/alpha', name: 'alpha' }, { cwd: 'D:/proj/beta', name: 'beta' }];
const setup = (record?: ManagedMemoryRecord) => {
  const onSaved = vi.fn(); const onCancel = vi.fn();
  return { onSaved, onCancel, ...render(<MemoryEditor userId="user-a" record={record} projects={projects} onSaved={onSaved} onCancel={onCancel} />) };
};
const saveButton = () => screen.getByRole('button', { name: '保存记忆' }) as HTMLButtonElement;
const contentInput = () => screen.getByLabelText('记忆正文') as HTMLTextAreaElement;

describe('MemoryEditor', () => {
  beforeEach(() => {
    vi.resetAllMocks(); vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(agentDataApi.memory.create).mockResolvedValue({ ...memoryRecord, origin: 'manual' });
    vi.mocked(agentDataApi.memory.update).mockResolvedValue({ ...memoryRecord, revision: 2 });
    vi.mocked(agentDataApi.memory.read).mockResolvedValue({ ...memoryRecord, revision: 2, content: '外部更新正文' });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it('requires explicit ownership and creates trimmed L1 content without transport extras', async () => {
    const { onSaved } = setup();
    fireEvent.change(contentInput(), { target: { value: '  新记忆  ' } });
    expect(saveButton().disabled).toBe(true);
    expectSelectDisplay('归属范围', '请选择归属范围');
    await pickSelectOption('归属范围', '全局');
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(agentDataApi.memory.create).toHaveBeenCalledWith({ userId: 'user-a', draft: { content: '新记忆', level: 1, owner: { scope: 'global' } } });
    await openSelect('编辑记忆层级');
    expect(screen.queryByRole('option', { name: '历史记录 · L0' })).toBeNull();
  });
  it('preserves missing project ownership, historical L0 and source on update', async () => {
    setup({ ...memoryRecord, level: 0, scope: 'project', sourceProjectId: 'D:/removed' });
    await openSelect('归属范围');
    expect(screen.getByRole('option', { name: /原项目已不可用/ })).toBeTruthy();
    fireEvent.change(contentInput(), { target: { value: ' 修订历史记忆 ' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(agentDataApi.memory.update).toHaveBeenCalledWith({ userId: 'user-a', id: memoryRecord.id, expectedRevision: 1, draft: { content: '修订历史记忆', level: 0, owner: { scope: 'project', projectId: 'D:/removed' }, source: memoryRecord.source } }));
  });
  it('retains dirty content and original revision when the same record refreshes', async () => {
    const { rerender, onSaved, onCancel } = setup(memoryRecord);
    fireEvent.change(contentInput(), { target: { value: '我的草稿' } });
    rerender(<MemoryEditor userId="user-a" record={{ ...memoryRecord, revision: 3, content: '后台正文' }} projects={projects} onSaved={onSaved} onCancel={onCancel} />);
    expect(contentInput().value).toBe('我的草稿');
    expect(screen.getByText(/数据已更新/)).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => expect(agentDataApi.memory.update).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 1, draft: expect.objectContaining({ content: '我的草稿' }) })));
  });
  it('preserves a conflict draft and reloads a new revision only after discard confirmation', async () => {
    setup(memoryRecord);
    vi.mocked(agentDataApi.memory.update).mockRejectedValueOnce({ code: 'VERSION_CONFLICT' });
    fireEvent.change(contentInput(), { target: { value: '冲突草稿' } });
    await pickSelectOption('归属范围', 'beta');
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toContain('记录已被修改，你的草稿已保留');
    expect(contentInput().value).toBe('冲突草稿');
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: '重新载入' }));
    expect(agentDataApi.memory.read).not.toHaveBeenCalled();
    const pending = deferred<ManagedMemoryRecord>(); vi.mocked(agentDataApi.memory.read).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: '重新载入' }));
    expect(contentInput().readOnly).toBe(true);
    fireEvent.change(contentInput(), { target: { value: '载入期间不能修改' } });
    expect(contentInput().value).toBe('冲突草稿');
    await act(async () => pending.resolve({ ...memoryRecord, revision: 7, content: '最新正文' }));
    expect(contentInput().value).toBe('最新正文');
    fireEvent.change(contentInput(), { target: { value: '新版本草稿' } }); fireEvent.click(saveButton());
    await waitFor(() => expect(agentDataApi.memory.update).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 7 })));
  });
  it('freezes input, dismissal and duplicate shortcuts during save', async () => {
    const pending = deferred<ManagedMemoryRecord>(); vi.mocked(agentDataApi.memory.update).mockReturnValueOnce(pending.promise);
    const { onCancel, onSaved } = setup(memoryRecord);
    fireEvent.change(contentInput(), { target: { value: '唯一提交' } });
    const editor = screen.getByRole('region', { name: '记忆编辑器' });
    expect(fireEvent.keyDown(editor, { key: 's', ctrlKey: true })).toBe(false);
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true, repeat: true });
    fireEvent.keyUp(editor, { key: 's', ctrlKey: true });
    fireEvent.change(contentInput(), { target: { value: '不能覆盖' } });
    fireEvent.keyDown(editor, { key: 'Escape' }); fireEvent.click(screen.getByRole('button', { name: '关闭编辑' }));
    expect(contentInput().value).toBe('唯一提交'); expect(onCancel).not.toHaveBeenCalled();
    expect(agentDataApi.memory.update).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ ...memoryRecord, revision: 2, content: '唯一提交' }));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
  it.each(['user', 'record'] as const)('isolates in-flight saves when the %s target changes without silently retargeting dirty content', async (change) => {
    const pending = deferred<ManagedMemoryRecord>(); vi.mocked(agentDataApi.memory.update).mockReturnValueOnce(pending.promise);
    const { rerender, onCancel, onSaved } = setup(memoryRecord);
    fireEvent.change(contentInput(), { target: { value: 'A 草稿' } }); fireEvent.click(saveButton());
    rerender(<MemoryEditor userId={change === 'user' ? 'user-b' : 'user-a'} record={change === 'record' ? { ...memoryRecord, id: 'record-b', content: 'B 正文' } : memoryRecord} projects={projects} onSaved={onSaved} onCancel={onCancel} />);
    await act(async () => pending.resolve({ ...memoryRecord, revision: 2, content: 'A 结果' }));
    expect(onSaved).not.toHaveBeenCalled(); expect(contentInput().value).toBe('A 草稿'); expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/原草稿仍保留/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '载入当前记录' }));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(agentDataApi.memory.read).toHaveBeenCalledWith({ userId: change === 'user' ? 'user-b' : 'user-a', id: change === 'record' ? 'record-b' : memoryRecord.id }));
  });
  it('ignores a stale reload after changing records', async () => {
    const pending = deferred<ManagedMemoryRecord>(); vi.mocked(agentDataApi.memory.read).mockReturnValueOnce(pending.promise);
    const { rerender, onCancel, onSaved } = setup(memoryRecord);
    fireEvent.click(screen.getByRole('button', { name: '重新载入' }));
    rerender(<MemoryEditor userId="user-a" record={{ ...memoryRecord, id: 'record-b', content: 'B 正文' }} projects={projects} onSaved={onSaved} onCancel={onCancel} />);
    await act(async () => pending.resolve({ ...memoryRecord, content: 'A 旧载入' }));
    expect(contentInput().value).toBe('B 正文'); expect(onSaved).not.toHaveBeenCalled();
  });
  it('preserves a deleted record draft but disables writes', async () => {
    setup(memoryRecord); vi.mocked(agentDataApi.memory.update).mockRejectedValueOnce(new Error('NOT_FOUND: missing'));
    fireEvent.change(contentInput(), { target: { value: '可复制的草稿' } }); fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toContain('记录已被外部删除');
    expect(contentInput().value).toBe('可复制的草稿'); expect(saveButton().disabled).toBe(true);
  });
  it('does not apply a pending save after deletion has been confirmed by the parent', async () => {
    const pending = deferred<ManagedMemoryRecord>(); vi.mocked(agentDataApi.memory.update).mockReturnValueOnce(pending.promise);
    const { rerender, onSaved, onCancel } = setup(memoryRecord);
    fireEvent.change(contentInput(), { target: { value: '保留已删除记录的草稿' } }); fireEvent.click(saveButton());
    rerender(<MemoryEditor userId="user-a" record={memoryRecord} unavailable projects={projects} onSaved={onSaved} onCancel={onCancel} />);
    await act(async () => pending.resolve({ ...memoryRecord, revision: 2, content: '迟到的保存成功' }));
    expect(onSaved).not.toHaveBeenCalled();
    expect(contentInput().value).toBe('保留已删除记录的草稿'); expect(saveButton().disabled).toBe(true);
  });
  it('keeps a draft when Escape discard is cancelled and closes only after confirmation', () => {
    const { onCancel } = setup(memoryRecord); vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.change(contentInput(), { target: { value: '保留草稿' } });
    fireEvent.keyDown(contentInput(), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled(); expect(contentInput().value).toBe('保留草稿');
    fireEvent.keyDown(contentInput(), { key: 'Escape' }); expect(onCancel).toHaveBeenCalledOnce();
  });
});
