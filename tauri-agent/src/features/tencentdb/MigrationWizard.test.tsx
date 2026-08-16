import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { api, execute, resolveManual, scan, setWorkspace, status, workspace } = vi.hoisted(() => {
  let workspace = '/ws';
  const scan = vi.fn(() => Promise.resolve({ report: { state: 'scanned', workspace: '/ws', runId: 'r1', items: [], totalCount: 0, manualCount: 0, updatedAt: '' }, verification: null }));
  const preview = vi.fn(() => Promise.resolve({ report: { state: 'preview', workspace: '/ws', runId: 'r1', items: [], totalCount: 0, manualCount: 0, updatedAt: '' }, verification: null }));
  const execute = vi.fn(() => Promise.resolve({ report: { state: 'verifying', workspace: '/ws', runId: 'r1', items: [], totalCount: 0, manualCount: 0, updatedAt: '' }, verification: null }));
  const verify = vi.fn(() => Promise.resolve({ report: { state: 'verified', workspace: '/ws', runId: 'r1', items: [], totalCount: 0, manualCount: 0, updatedAt: '' }, verification: { passed: true, errors: [], gatewayHealthy: true, knowledgeHealthy: true, countsMatch: true, sampleQuery: true, piRecall: true, checkedAt: '' } }));
  const archive = vi.fn(() => Promise.resolve({ report: { state: 'archived', workspace: '/ws', runId: 'r1', items: [], totalCount: 0, manualCount: 0, updatedAt: '' }, verification: { passed: true, errors: [], gatewayHealthy: true, knowledgeHealthy: true, countsMatch: true, sampleQuery: true, piRecall: true, checkedAt: '' } }));
  const resolveManual = vi.fn<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve({ report: { state: 'preview', workspace: '/ws', runId: 'r1', items: [], totalCount: 0, manualCount: 0, updatedAt: '' }, verification: null }));
  const status = vi.fn<(workspace?: string) => Promise<unknown>>(() => Promise.resolve(null));
  const api = { migrationStatus: status, migrationScan: scan, migrationPreview: preview, migrationExecute: execute, migrationVerify: verify, migrationArchive: archive, migrationResolveManual: resolveManual };
  return { api, scan, preview, execute, verify, archive, resolveManual, status, setWorkspace: (next: string) => { workspace = next; }, workspace: () => workspace };
});

vi.mock('./tencentdbApi', () => ({ tencentdbApi: api }));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: workspace() }),
}));

import { MigrationWizard } from './MigrationWizard';

afterEach(() => {
  cleanup();
  localStorage.clear();
  setWorkspace('/ws');
  vi.clearAllMocks();
});

describe('MigrationWizard', () => {
  it('starts with a read-only scan and exposes the next preview step', async () => {
    render(<MigrationWizard />);
    expect(screen.getByText(/不会删除任何 SQLite/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /扫描来源/ }));
    await waitFor(() => expect(scan).toHaveBeenCalledWith('/ws'));
    expect(screen.getByText(/当前状态/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /预览/ })).not.toBeDisabled();
  });

  it('shows persisted batch audit data and can resume an interrupted execution', async () => {
    status.mockResolvedValueOnce({
      report: {
        state: 'executing',
        workspace: '/ws',
        runId: 'r1',
        items: [{ sourceId: 'memory:/legacy.db', sourceKind: 'memory_sqlite', sourcePath: '/legacy.db', state: 'failed', itemCount: 3, byteCount: 100, migratedCount: 0, targetId: null, error: '连接中断', retryable: true, metadata: {} }],
        totalCount: 3,
        manualCount: 0,
        updatedAt: '',
      },
      batches: [
        {
          sourceId: 'memory:/legacy.db',
          targetId: 'legacy-m1',
          count: 3,
          errors: ['连接中断'],
          retryable: true,
        },
      ],
      verification: null,
    });

    render(<MigrationWizard />);
    expect(await screen.findByText('迁移批次')).toBeTruthy();
    expect(screen.getByText('memory:/legacy.db')).toBeTruthy();
    expect(screen.getAllByText('连接中断')).toHaveLength(2);
    const executeButton = screen.getByRole('button', { name: /继续导入/ });
    expect(executeButton).not.toBeDisabled();
    fireEvent.click(executeButton);
    await waitFor(() => expect(execute).toHaveBeenCalledWith('/ws', ['memory:/legacy.db']));
  });

  it('executes only the sources selected in preview', async () => {
    status.mockResolvedValueOnce({
      report: {
        state: 'preview',
        workspace: '/ws',
        runId: 'r2',
        items: [
          { sourceId: 'memory:/legacy.db', sourceKind: 'memory_sqlite', sourcePath: '/legacy.db', state: 'scanned', itemCount: 1, byteCount: 10, migratedCount: 0, targetId: null, error: null, retryable: false, metadata: {} },
          { sourceId: 'skill:/review', sourceKind: 'skill', sourcePath: '/review', state: 'scanned', itemCount: 1, byteCount: 10, migratedCount: 0, targetId: null, error: null, retryable: false, metadata: {} },
        ],
        totalCount: 2,
        manualCount: 0,
        updatedAt: '',
      },
      batches: [],
      verification: null,
    });

    render(<MigrationWizard />);
    const skill = await screen.findByRole('checkbox', { name: /本地 Skill/ });
    fireEvent.click(skill);
    fireEvent.click(screen.getByRole('button', { name: /执行导入/ }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith('/ws', ['memory:/legacy.db']));
  });

  it('restores the selected source set after the wizard is remounted', async () => {
    const run = {
      report: {
        state: 'preview' as const,
        workspace: '/ws',
        runId: 'r-persisted-selection',
        items: [
          { sourceId: 'memory:/legacy.db', sourceKind: 'memory_sqlite' as const, sourcePath: '/legacy.db', state: 'scanned' as const, itemCount: 1, byteCount: 10, migratedCount: 0, targetId: null, error: null, retryable: false, metadata: {} },
          { sourceId: 'skill:/review', sourceKind: 'skill' as const, sourcePath: '/review', state: 'scanned' as const, itemCount: 1, byteCount: 10, migratedCount: 0, targetId: null, error: null, retryable: false, metadata: {} },
        ],
        totalCount: 2,
        manualCount: 0,
        updatedAt: '',
      },
      batches: [],
      verification: null,
    };
    status.mockResolvedValue(run);

    const first = render(<MigrationWizard />);
    const skill = await first.findByRole('checkbox', { name: /本地 Skill/ });
    fireEvent.click(skill);
    first.unmount();

    render(<MigrationWizard />);
    const executeButton = await screen.findByRole('button', { name: /执行导入/ });
    fireEvent.click(executeButton);
    await waitFor(() => expect(execute).toHaveBeenCalledWith('/ws', ['memory:/legacy.db']));
  });

  it('prefers the latest local selection over stale server selected ids', async () => {
    const runId = 'r-stale-server-selection';
    const storageKey = `tencentdb-migration-selection:${encodeURIComponent('/ws')}:${encodeURIComponent(runId)}`;
    localStorage.setItem(storageKey, JSON.stringify({ runId, selectedIds: ['memory:/legacy.db'] }));
    status.mockResolvedValueOnce({
      report: {
        state: 'preview',
        workspace: '/ws',
        runId,
        items: [
          { sourceId: 'memory:/legacy.db', sourceKind: 'memory_sqlite', sourcePath: '/legacy.db', state: 'scanned', itemCount: 1, byteCount: 10, migratedCount: 0, targetId: null, error: null, retryable: false, metadata: {} },
          { sourceId: 'skill:/review', sourceKind: 'skill', sourcePath: '/review', state: 'scanned', itemCount: 1, byteCount: 10, migratedCount: 0, targetId: null, error: null, retryable: false, metadata: {} },
        ],
        totalCount: 2,
        manualCount: 0,
        updatedAt: '',
      },
      batches: [],
      selectedIds: ['memory:/legacy.db', 'skill:/review'],
      verification: null,
    });

    render(<MigrationWizard />);
    const executeButton = await screen.findByRole('button', { name: /执行导入/ });
    fireEvent.click(executeButton);
    await waitFor(() => expect(execute).toHaveBeenCalledWith('/ws', ['memory:/legacy.db']));
  });

  it('requires an explicit manual resolution and shows the persisted resolution', async () => {
    const manualItem = {
      sourceId: 'wiki:/legacy',
      sourceKind: 'wiki' as const,
      sourcePath: '/legacy/wiki',
      state: 'manual' as const,
      itemCount: 2,
      byteCount: 20,
      migratedCount: 0,
      targetId: null,
      error: '无法自动导入',
      retryable: false,
      metadata: {},
    };
    status.mockResolvedValueOnce({
      report: { state: 'manual', workspace: '/ws', runId: 'r-manual', items: [manualItem], totalCount: 2, manualCount: 1, updatedAt: '' },
      batches: [],
      verification: null,
    });
    resolveManual.mockResolvedValueOnce({
      report: {
        state: 'verified',
        workspace: '/ws',
        runId: 'r-manual',
        items: [{
          ...manualItem,
          manualResolution: { kind: 'explicit_waived', note: '确认保留旧数据供审计', resolvedAt: '2026-08-16T09:30:00Z' },
        }],
        totalCount: 2,
        manualCount: 0,
        updatedAt: '',
      },
      batches: [],
      verification: null,
    });

    render(<MigrationWizard />);
    expect(await screen.findByText(/尚未完成人工处置/)).toBeTruthy();
    const submit = screen.getByRole('button', { name: '确认人工处置' });
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: '明确豁免并保留旧数据' }));
    fireEvent.change(screen.getByPlaceholderText('填写处理备注'), { target: { value: '   ' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('填写处理备注'), { target: { value: '  确认保留旧数据供审计  ' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(resolveManual).toHaveBeenCalledWith('/ws', 'r-manual', 'wiki:/legacy', 'explicit_waived', '确认保留旧数据供审计'));
    expect(await screen.findByText('处理时间：2026-08-16T09:30:00Z')).toBeTruthy();
    expect(screen.getByText('明确豁免并保留旧数据')).toBeTruthy();
    expect(screen.getByText('备注：确认保留旧数据供审计')).toBeTruthy();
    expect(screen.queryByText(/尚未完成人工处置/)).toBeNull();
  });

  it('keeps archive retry available when the run is already archived', async () => {
    status.mockResolvedValueOnce({
      report: { state: 'archived', workspace: '/ws', runId: 'r3', items: [], totalCount: 0, manualCount: 0, updatedAt: '' },
      batches: [],
      verification: { passed: true, errors: [], gatewayHealthy: true, knowledgeHealthy: true, countsMatch: true, sampleQuery: true, piRecall: true, checkedAt: '' },
      archivedAt: 'now',
    });

    render(<MigrationWizard />);
    const archiveButton = await screen.findByRole('button', { name: /归档旧链路/ });
    expect(archiveButton).not.toBeDisabled();
    fireEvent.click(archiveButton);
    await waitFor(() => expect(api.migrationArchive).toHaveBeenCalledWith('/ws'));
  });

  it('keeps selections isolated when another workspace has the same run id', async () => {
    const reportFor = (nextWorkspace: string) => ({
      report: {
        state: 'preview' as const,
        workspace: nextWorkspace,
        runId: 'shared-run-id',
        items: [
          { sourceId: 'memory:/legacy.db', sourceKind: 'memory_sqlite' as const, sourcePath: '/legacy.db', state: 'scanned' as const, itemCount: 1, byteCount: 10, migratedCount: 0, targetId: null, error: null, retryable: false, metadata: {} },
          { sourceId: 'skill:/review', sourceKind: 'skill' as const, sourcePath: '/review', state: 'scanned' as const, itemCount: 1, byteCount: 10, migratedCount: 0, targetId: null, error: null, retryable: false, metadata: {} },
        ],
        totalCount: 2,
        manualCount: 0,
        updatedAt: '',
      },
      batches: [],
      verification: null,
    });
    status.mockImplementation((nextWorkspace?: string) => Promise.resolve(reportFor(nextWorkspace ?? '/ws')));

    const view = render(<MigrationWizard />);
    const skill = await view.findByRole('checkbox', { name: /本地 Skill/ });
    fireEvent.click(skill);

    setWorkspace('/another-workspace');
    view.rerender(<MigrationWizard />);
    await waitFor(() => expect(status).toHaveBeenLastCalledWith('/another-workspace'));
    expect(await screen.findByRole('checkbox', { name: /本地 Skill/ })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /执行导入/ }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith('/another-workspace', ['memory:/legacy.db', 'skill:/review']));
  });

  it('ignores a stale status response after the workspace changes', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const runFor = (nextWorkspace: string, sourcePath: string) => ({
      report: {
        state: 'scanned' as const,
        workspace: nextWorkspace,
        runId: `run:${nextWorkspace}`,
        items: [{ sourceId: `skill:${sourcePath}`, sourceKind: 'skill' as const, sourcePath, state: 'scanned' as const, itemCount: 1, byteCount: 10, migratedCount: 0, targetId: null, error: null, retryable: false, metadata: {} }],
        totalCount: 1,
        manualCount: 0,
        updatedAt: '',
      },
      batches: [],
      verification: null,
    });
    status
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(runFor('/another-workspace', '/current-skill'));

    const view = render(<MigrationWizard />);
    await waitFor(() => expect(status).toHaveBeenCalledWith('/ws'));

    setWorkspace('/another-workspace');
    view.rerender(<MigrationWizard />);
    expect(await screen.findByText('/current-skill')).toBeTruthy();

    await act(async () => {
      resolveFirst?.(runFor('/ws', '/stale-skill'));
      await Promise.resolve();
    });
    expect(screen.queryByText('/stale-skill')).toBeNull();
    expect(screen.getByText('/current-skill')).toBeTruthy();
  });
});
