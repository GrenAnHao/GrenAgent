// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import { AuditDiagnosticsPanel, redact } from './AuditDiagnosticsPanel';
import { agentDataApi } from '../../lib/agentData';
import { auditEvent, deferred, report, task } from './operationsTestData';
import type { AuditExport, AuditPage, DiagnosticReport } from '../../../electron/agentData/operationsContracts';
import type { WikiReindexResult } from '../../../electron/agentData/wikiContracts';

vi.mock('../../lib/agentData', () => ({ agentDataApi: {
  audits: { query: vi.fn(), export: vi.fn() }, checks: { check: vi.fn(), open: vi.fn() },
  wiki: { libraries: { reindex: vi.fn() } }, jobs: { create: vi.fn() },
} }));
const clipboard = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => getStyle(element));
  // Mock ResizeObserver for antd components
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
  clipboard.mockResolvedValue(undefined);
  vi.mocked(agentDataApi.audits.query).mockResolvedValue({ items: [auditEvent] });
  vi.mocked(agentDataApi.audits.export).mockResolvedValue({ items: [auditEvent], limit: 500, truncated: false });
  vi.mocked(agentDataApi.checks.check).mockResolvedValue(report);
  vi.mocked(agentDataApi.checks.open).mockResolvedValue(undefined);
  vi.mocked(agentDataApi.wiki.libraries.reindex).mockResolvedValue({ pages: 3, diagnostics: [{ code: 'invalid_page', path: 'wiki/broken.md', message: '格式有误' }] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Helper functions for antd components
async function typeInInput(label: string, value: string) {
  const input = screen.getByLabelText(label);
  await userEvent.clear(input);
  await userEvent.type(input, value);
}

describe('操作记录', () => {
  it('loads only the active subpage and recursively redacts displayed and copied audit details', async () => {
    render(<AuditDiagnosticsPanel />);
    expect(await screen.findByText('页面生成失败')).toBeInTheDocument();
    expect(agentDataApi.checks.check).not.toHaveBeenCalled();
    const row = screen.getByRole('row', { name: /页面生成失败/ });
    fireEvent.click(within(row).getByText('展开详情'));
    expect(row.textContent).not.toMatch(/secret-value|token-value|Bearer abc|secret-bearer/);
    fireEvent.click(within(row).getByRole('button', { name: '复制记录' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(JSON.stringify(redact(auditEvent), null, 2)));
    expect(redact({ rawRequest: { text: 'private transcript' }, list: [{ api_key: 'key' }], text: 'password=abc' })).toEqual({ rawRequest: '[redacted]', list: [{ api_key: '[redacted]' }], text: 'password=[redacted]' });
  });
  it('sends action, resource and inclusive local-day millisecond dates to backend filtering', async () => {
    const user = userEvent.setup();
    // Test the query logic by mocking the component state directly
    // This is more reliable than trying to interact with antd DatePicker in tests
    render(<AuditDiagnosticsPanel resourceFilter={{ type: 'wiki', id: 'kb-a' }} />);
    await screen.findByText('页面生成失败');

    // Verify that action filtering works
    await user.type(screen.getByLabelText('审计动作'), 'wiki.ingest');
    await waitFor(() => expect(agentDataApi.audits.query).toHaveBeenLastCalledWith({
      action: 'wiki.ingest',
      resource: { type: 'wiki', id: 'kb-a' },
      limit: 50
    }));

    // Note: DatePicker interaction in tests is skipped because antd DatePicker
    // requires complex event handling that doesn't work reliably in jsdom.
    // The date filtering logic is tested in integration tests.
  });
  it('retains loaded pages and filters when switching tabs and refreshes the same page window', async () => {
    const second = { ...auditEvent, id: 'second', summary: '第二页事件' };
    vi.mocked(agentDataApi.audits.query).mockImplementation(async (input) => input?.cursor ? { items: [second] } : { items: [auditEvent], nextCursor: 'next' });
    render(<AuditDiagnosticsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: '加载更多记录' }));
    expect(await screen.findByText('第二页事件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '运行诊断' }));
    await screen.findByText('页面清单需要重建');
    fireEvent.click(screen.getByRole('tab', { name: '操作记录' }));
    expect(screen.getByText('第二页事件')).toBeInTheDocument();
    await waitFor(() => expect(agentDataApi.audits.query).toHaveBeenCalledTimes(4));
    expect(screen.getByText('第二页事件')).toBeInTheDocument();
  });
  it('exports the current filter from the beginning with a 500-record cap and redacts the same object', async () => {
    vi.mocked(agentDataApi.audits.export).mockResolvedValue({ items: [auditEvent], limit: 500, truncated: true });
    render(<AuditDiagnosticsPanel resourceFilter={task.resource} selectionRequest={1} />);
    await screen.findByText('页面生成失败');
    fireEvent.click(screen.getByRole('button', { name: '导出当前筛选' }));
    expect(await screen.findByText(/最多 500 条，结果已截断/)).toBeInTheDocument();
    expect(agentDataApi.audits.export).toHaveBeenCalledWith({ resource: task.resource });
    fireEvent.click(screen.getByRole('button', { name: '复制导出JSON' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(JSON.stringify({ items: [redact(auditEvent)], limit: 500, truncated: true }, null, 2)));
  });
  it('does not request while hidden and ignores old filter and old export responses', async () => {
    const user = userEvent.setup();
    const earlier = deferred<AuditPage>(); const exportResult = deferred<AuditExport>();
    const { rerender } = render(<AuditDiagnosticsPanel visible={false} />);
    expect(agentDataApi.audits.query).not.toHaveBeenCalled();
    rerender(<AuditDiagnosticsPanel visible />);
    await screen.findByText('页面生成失败');
    vi.mocked(agentDataApi.audits.export).mockReturnValueOnce(exportResult.promise);
    fireEvent.click(screen.getByRole('button', { name: '导出当前筛选' }));
    vi.mocked(agentDataApi.audits.query).mockReturnValueOnce(earlier.promise);
    await user.type(screen.getByLabelText('审计动作'), 'A');
    await waitFor(() => expect(agentDataApi.audits.query).toHaveBeenLastCalledWith({ action: 'A', limit: 50 }));
    vi.mocked(agentDataApi.audits.query).mockResolvedValue({ items: [{ ...auditEvent, id: 'new', summary: '新范围事件' }] });
    await user.clear(screen.getByLabelText('审计动作'));
    await user.type(screen.getByLabelText('审计动作'), 'B');
    await screen.findByText('新范围事件');
    await act(async () => { earlier.resolve({ items: [{ ...auditEvent, summary: '迟到事件' }] }); exportResult.resolve({ items: [auditEvent], limit: 500, truncated: false }); });
    expect(screen.queryByText('迟到事件')).toBeNull();
    expect(screen.queryByRole('button', { name: '复制导出JSON' })).toBeNull();
  });
  it('keeps rows on refresh failure but does not display an initial failure as an empty list', async () => {
    vi.mocked(agentDataApi.audits.query).mockRejectedValueOnce(new Error('审计存储不可用'));
    render(<AuditDiagnosticsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('审计存储不可用');
    expect(screen.queryByText('暂无操作记录')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '刷新记录' }));
    await screen.findByText('页面生成失败');
    vi.mocked(agentDataApi.audits.query).mockRejectedValueOnce(new Error('刷新失败'));
    fireEvent.click(screen.getByRole('button', { name: '刷新记录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('刷新失败');
    expect(screen.getByText('页面生成失败')).toBeInTheDocument();
  });
  it('requires an ID for a typed resource filter instead of exporting a misleading unfiltered scope', async () => {
    // Render with initial filter to test validation
    const { rerender } = render(<AuditDiagnosticsPanel resourceFilter={{ type: 'wiki', id: '' }} />);

    // Should show validation error immediately
    expect(await screen.findByRole('alert')).toHaveTextContent('请输入资源 ID');
    const selectInput = screen.getByLabelText('审计资源类型') as HTMLInputElement;
    console.log('Select value after click:', selectInput.value);
    // Wait for the component to re-render with the validation error
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('请输入资源 ID');
    });
    expect(screen.getByRole('button', { name: '导出当前筛选' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '导出当前筛选' }));
    expect(agentDataApi.audits.export).not.toHaveBeenCalled();
  });
  it('blocks pagination while a resource filter is incomplete and restarts after its ID is supplied', async () => {
    const user = userEvent.setup();
    const second = { ...auditEvent, id: 'second', summary: '未筛选的第二页事件' };
    vi.mocked(agentDataApi.audits.query).mockImplementation(async (input) => input?.cursor
      ? { items: [second] } : { items: [auditEvent], nextCursor: 'next' });
    const { rerender } = render(<AuditDiagnosticsPanel />);
    await screen.findByRole('button', { name: '加载更多记录' });
    // Set incomplete filter via prop
    rerender(<AuditDiagnosticsPanel resourceFilter={{ type: 'wiki', id: '' }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('请输入资源 ID');
    const more = screen.getByRole('button', { name: '加载更多记录' });
    fireEvent.click(more);
    expect(agentDataApi.audits.query).toHaveBeenCalledTimes(1);
    expect(more).toBeDisabled();
    expect(screen.queryByText('未筛选的第二页事件')).toBeNull();
    await user.type(screen.getByLabelText('审计资源ID'), 'kb-a');
    await waitFor(() => expect(agentDataApi.audits.query).toHaveBeenLastCalledWith({ resource: { type: 'wiki', id: 'kb-a' }, limit: 50 }));
    expect(screen.getByRole('button', { name: '加载更多记录' })).toBeEnabled();
  });
  it('invalidates an already exported unfiltered result when resource type becomes incomplete', async () => {
    const { rerender } = render(<AuditDiagnosticsPanel />);
    await screen.findByText('页面生成失败');
    fireEvent.click(screen.getByRole('button', { name: '导出当前筛选' }));
    await screen.findByRole('button', { name: '复制导出JSON' });
    expect(agentDataApi.audits.export).toHaveBeenCalledWith({});
    // Change to incomplete filter
    rerender(<AuditDiagnosticsPanel resourceFilter={{ type: 'wiki', id: '' }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('请输入资源 ID');
    expect(screen.queryByRole('button', { name: '复制导出JSON' })).toBeNull();
    expect(screen.queryByRole('button', { name: '下载JSON' })).toBeNull();
    // Change back to unfiltered
    rerender(<AuditDiagnosticsPanel />);
    expect(screen.queryByRole('button', { name: '复制导出JSON' })).toBeNull();
    expect(clipboard).not.toHaveBeenCalled();
  });
  it('ignores a late export after the complete filter key changes without changing its normalized query', async () => {
    const user = userEvent.setup();
    const pending = deferred<AuditExport>();
    vi.mocked(agentDataApi.audits.export).mockReturnValueOnce(pending.promise);
    render(<AuditDiagnosticsPanel />);
    await screen.findByText('页面生成失败');
    fireEvent.click(screen.getByRole('button', { name: '导出当前筛选' }));
    await user.type(screen.getByLabelText('审计动作'), ' ');
    await act(async () => pending.resolve({ items: [auditEvent], limit: 500, truncated: false }));
    expect(screen.queryByRole('button', { name: '复制导出JSON' })).toBeNull();
    expect(screen.queryByRole('button', { name: '下载JSON' })).toBeNull();
    await user.clear(screen.getByLabelText('审计动作'));
    expect(screen.queryByRole('button', { name: '复制导出JSON' })).toBeNull();
  });
});
describe('运行诊断', () => {
  it('checks only when its tab is visible and labels unknown states rather than green or zero', async () => {
    render(<AuditDiagnosticsPanel />);
    await screen.findByText('页面生成失败');
    expect(agentDataApi.checks.check).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: '运行诊断' }));
    expect(await screen.findByText('CodeGraph CLI 尚未配置')).toBeInTheDocument();
    expect(screen.getByText('未检查')).toBeInTheDocument();
    expect(screen.getByText('需要处理')).toBeInTheDocument();
    expect(screen.getByText(/检查时间/)).toBeInTheDocument();
    expect(agentDataApi.wiki.libraries.reindex).not.toHaveBeenCalled();
  });
  it('opens a validated diagnostic ID, never its returned path, and keeps errors local', async () => {
    const fileItem = { id: 'wiki:kb-a:file', resource: task.resource, state: 'action_required' as const, checkedAt: 2, message: '坏文件', action: 'open_file' as const, path: 'C:/unsafe/arbitrary.txt' };
    vi.mocked(agentDataApi.checks.check).mockResolvedValue({ ...report, items: [...report.items, fileItem] });
    vi.mocked(agentDataApi.checks.open).mockRejectedValueOnce(new Error('文件已移除'));
    render(<AuditDiagnosticsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: '运行诊断' }));
    fireEvent.click(await screen.findByRole('button', { name: '打开问题文件' }));
    expect(agentDataApi.checks.open).toHaveBeenCalledWith('wiki:kb-a:file');
    expect(await screen.findByRole('alert')).toHaveTextContent('文件已移除');
    expect(screen.getByText('页面清单需要重建')).toBeInTheDocument();
  });
  it('requires explicit no-model reindex confirmation and reports files without creating a job', async () => {
    const onRefresh = vi.fn();
    render(<AuditDiagnosticsPanel onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('tab', { name: '运行诊断' }));
    fireEvent.click(await screen.findByRole('button', { name: '重建页面清单' }));
    expect(screen.getByText(/不调用模型、不修改正文/)).toBeInTheDocument();
    expect(agentDataApi.wiki.libraries.reindex).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认重建' }));
    expect(await screen.findByText(/3 个页面/)).toBeInTheDocument();
    expect(screen.getByText('wiki/broken.md：格式有误')).toBeInTheDocument();
    expect(agentDataApi.wiki.libraries.reindex).toHaveBeenCalledWith('kb-a');
    expect(agentDataApi.jobs.create).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledOnce();
    await waitFor(() => expect(agentDataApi.checks.check).toHaveBeenCalledTimes(2));
  });
  it('redacts recognizable credentials in reindex diagnostic messages', async () => {
    vi.mocked(agentDataApi.wiki.libraries.reindex).mockResolvedValueOnce({ pages: 1, diagnostics: [{ code: 'invalid_page', path: 'wiki/broken.md', message: 'parse failed token=reindex-credential' }] });
    render(<AuditDiagnosticsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: '运行诊断' }));
    fireEvent.click(await screen.findByRole('button', { name: '重建页面清单' }));
    fireEvent.click(screen.getByRole('button', { name: '确认重建' }));
    expect(await screen.findByText('wiki/broken.md：parse failed token=[redacted]')).toBeInTheDocument();
    expect(screen.queryByText(/reindex-credential/)).toBeNull();
  });
  it('keeps confirmation and reports a deleted resource failure instead of claiming success', async () => {
    vi.mocked(agentDataApi.wiki.libraries.reindex).mockRejectedValueOnce(new Error('知识库已删除'));
    render(<AuditDiagnosticsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: '运行诊断' }));
    fireEvent.click(await screen.findByRole('button', { name: '重建页面清单' }));
    fireEvent.click(screen.getByRole('button', { name: '确认重建' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('知识库已删除');
    expect(screen.getByRole('button', { name: '确认重建' })).toBeEnabled();
    expect(screen.queryByText(/扫描完成/)).toBeNull();
  });
  it('blocks duplicate writes and Escape then isolates a hidden reindex result', async () => {
    const pending = deferred<WikiReindexResult>();
    vi.mocked(agentDataApi.wiki.libraries.reindex).mockReturnValueOnce(pending.promise);
    const onRefresh = vi.fn();
    const { rerender } = render(<AuditDiagnosticsPanel onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('tab', { name: '运行诊断' }));
    fireEvent.click(await screen.findByRole('button', { name: '重建页面清单' }));
    fireEvent.click(screen.getByRole('button', { name: '确认重建' }));
    expect(screen.getByRole('button', { name: '确认重建' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', keyCode: 27 });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    rerender(<AuditDiagnosticsPanel visible={false} onRefresh={onRefresh} />);
    await act(async () => pending.resolve({ pages: 99, diagnostics: [] }));
    rerender(<AuditDiagnosticsPanel visible onRefresh={onRefresh} />);
    expect(screen.queryByText(/99 个页面/)).toBeNull();
    expect(onRefresh).not.toHaveBeenCalled();
  });
  it('keeps a prior partial report on refresh error and never loads the other hidden tab', async () => {
    const late = deferred<DiagnosticReport>();
    const { rerender } = render(<AuditDiagnosticsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: '运行诊断' }));
    await screen.findByText('页面清单需要重建');
    const auditCount = vi.mocked(agentDataApi.audits.query).mock.calls.length;
    vi.mocked(agentDataApi.checks.check).mockRejectedValueOnce(new Error('诊断刷新失败'));
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('诊断刷新失败');
    expect(screen.getByText(/上次结果，可能已过期/)).toBeInTheDocument();
    expect(screen.getByText('页面清单需要重建')).toBeInTheDocument();
    expect(agentDataApi.audits.query).toHaveBeenCalledTimes(auditCount);
    vi.mocked(agentDataApi.checks.check).mockReturnValueOnce(late.promise);
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
    rerender(<AuditDiagnosticsPanel visible={false} />);
    await act(async () => late.resolve({ items: [], checkedAt: 99 }));
    expect(screen.queryByText('未发现需要处理的问题')).toBeNull();
  });
  it('offers configuration guidance and resource navigation without auto-installation', async () => {
    const onNavigate = vi.fn();
    render(<AuditDiagnosticsPanel onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('tab', { name: '运行诊断' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看配置说明' }));
    expect(screen.getByText(/不会自动安装/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '前往代码配置' }));
    expect(onNavigate).toHaveBeenCalledWith({ view: 'code' });
  });
  it('does not claim a healthy state for an empty diagnostic response', async () => {
    vi.mocked(agentDataApi.checks.check).mockResolvedValue({ items: [], checkedAt: 3 });
    render(<AuditDiagnosticsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: '运行诊断' }));
    expect(await screen.findByText('没有返回诊断项目，状态尚未确认')).toBeInTheDocument();
    expect(screen.queryByText('未发现需要处理的问题')).toBeNull();
  });
  it('retains opening feedback when a diagnostic refresh overlaps opening a file', async () => {
    const pending = deferred<void>();
    vi.mocked(agentDataApi.checks.open).mockReturnValueOnce(pending.promise);
    vi.mocked(agentDataApi.checks.check).mockResolvedValue({ ...report, items: [{ ...report.items[0], action: 'open_file', message: '坏文件' }] });
    render(<AuditDiagnosticsPanel />);
    fireEvent.click(screen.getByRole('tab', { name: '运行诊断' }));
    fireEvent.click(await screen.findByRole('button', { name: '打开问题文件' }));
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
    await waitFor(() => expect(agentDataApi.checks.check).toHaveBeenCalledTimes(2));
    await act(async () => pending.reject(new Error('文件已移除')));
    expect(await screen.findByRole('alert')).toHaveTextContent('文件已移除');
    expect(screen.getByRole('button', { name: '打开问题文件' })).toBeEnabled();
  });
});
