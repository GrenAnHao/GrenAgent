import { Alert, Button, Checkbox, Input, List, Radio, Space, Tag } from 'antd';
import { Flexbox } from '@lobehub/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { tencentdbApi, type TencentdbManualResolutionKind, type TencentdbMigrationRun, type TencentdbMigrationState } from './tencentdbApi';

export const MIGRATION_SELECTION_STORAGE_KEY = 'tencentdb-migration-selection';

interface PersistedMigrationSelection {
  runId: string;
  selectedIds: string[];
}

interface SelectionState {
  runId: string;
  selectedIds: Set<string>;
}

function selectionStorageKey(workspace: string, runId: string): string {
  return `${MIGRATION_SELECTION_STORAGE_KEY}:${encodeURIComponent(workspace)}:${encodeURIComponent(runId)}`;
}

function readPersistedSelection(workspace: string, runId: string, availableIds: string[], serverSelectedIds?: string[] | null): Set<string> {
  const available = new Set(availableIds);
  let persistedIds: string[] | undefined;

  let hasLocalSelection = false;
  try {
    const raw = localStorage.getItem(selectionStorageKey(workspace, runId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedMigrationSelection>;
      if (parsed?.runId === runId && Array.isArray(parsed.selectedIds)) {
        persistedIds = parsed.selectedIds;
        hasLocalSelection = true;
      }
    }
  } catch {
    // Ignore malformed or unavailable browser storage and use the server default.
  }
  if (!hasLocalSelection && Array.isArray(serverSelectedIds)) {
    persistedIds = serverSelectedIds;
  }

  return new Set((persistedIds ?? availableIds).filter((id): id is string => typeof id === 'string' && available.has(id)));
}

function persistSelection(workspace: string, runId: string, selectedIds: Iterable<string>): void {
  try {
    const value: PersistedMigrationSelection = { runId, selectedIds: [...new Set(selectedIds)] };
    localStorage.setItem(selectionStorageKey(workspace, runId), JSON.stringify(value));
  } catch {
    // Selection persistence is best effort; migration itself remains server-backed.
  }
}

const STATE_LABELS: Record<TencentdbMigrationState, string> = {
  scanned: '已扫描',
  preview: '待执行',
  executing: '执行中',
  verifying: '待验证',
  migrated: '已导入',
  verified: '已验证',
  archived: '已归档',
  manual: '需人工处理',
  failed: '失败，可重试',
};

const KIND_LABELS: Record<string, string> = {
  memory_sqlite: '旧 L1 SQLite',
  session_jsonl: 'Pi 会话 L0',
  skill: '本地 Skill',
  wiki: 'Wiki 原始文档',
  code_graph: 'Git CodeGraph',
};

const MANUAL_RESOLUTION_LABELS: Record<TencentdbManualResolutionKind, string> = {
  external_completed: '已在外部完成迁移',
  explicit_waived: '明确豁免并保留旧数据',
};

function stateTag(state: TencentdbMigrationState) {
  const color = state === 'failed' ? 'error' : state === 'manual' ? 'warning' : state === 'archived' ? 'success' : 'processing';
  return <Tag color={color}>{STATE_LABELS[state]}</Tag>;
}

function isSelectable(state: TencentdbMigrationState) {
  return state === 'scanned' || state === 'preview' || state === 'failed';
}

interface ManualResolutionDraft {
  kind?: TencentdbManualResolutionKind;
  note: string;
}

export function MigrationWizard() {
  const { workspace } = useAgentStoreContext();
  const [run, setRun] = useState<TencentdbMigrationRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionState>({ runId: '', selectedIds: new Set() });
  const [manualDrafts, setManualDrafts] = useState<Record<string, ManualResolutionDraft>>({});
  const requestVersionRef = useRef(0);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  const applyRun = useCallback((nextRun: TencentdbMigrationRun | null) => {
    setRun(nextRun);
    const report = nextRun?.report;
    if (!report) {
      setSelection({ runId: '', selectedIds: new Set() });
      return;
    }
    const availableIds = report.items.filter((item) => isSelectable(item.state)).map((item) => item.sourceId);
    const selectedIds = readPersistedSelection(workspace, report.runId, availableIds, nextRun.selectedIds);
    setSelection({ runId: report.runId, selectedIds });
    persistSelection(workspace, report.runId, selectedIds);
  }, [workspace]);

  const reload = useCallback(async () => {
    const requestWorkspace = workspace;
    const requestVersion = ++requestVersionRef.current;
    try {
      const nextRun = await tencentdbApi.migrationStatus(requestWorkspace);
      if (requestVersion !== requestVersionRef.current || requestWorkspace !== workspaceRef.current) return;
      applyRun(nextRun);
      setError(null);
    } catch (cause) {
      if (requestVersion !== requestVersionRef.current || requestWorkspace !== workspaceRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [applyRun, workspace]);

  useEffect(() => {
    applyRun(null);
    setLoading(false);
    setError(null);
    void reload();
  }, [applyRun, reload]);

  const act = async (operation: () => Promise<TencentdbMigrationRun>) => {
    const requestWorkspace = workspace;
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError(null);
    try {
      const nextRun = await operation();
      if (requestVersion !== requestVersionRef.current || requestWorkspace !== workspaceRef.current) return;
      applyRun(nextRun);
    } catch (cause) {
      if (requestVersion !== requestVersionRef.current || requestWorkspace !== workspaceRef.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestVersion === requestVersionRef.current && requestWorkspace === workspaceRef.current) {
        setLoading(false);
      }
    }
  };

  const report = run?.report;
  const canPreview = report?.state === 'scanned';
  const canExecute = report?.state === 'preview' || report?.state === 'executing' || report?.state === 'failed';
  const canVerify = report?.state === 'verifying' || report?.state === 'migrated';
  // Keep the idempotent marker repair action available for already archived
  // runs loaded from older versions or after an interrupted response.
  const canArchive = (report?.state === 'verified' || report?.state === 'archived') && run?.verification?.passed;
  const manualItems = useMemo(() => report?.items.filter((item) => item.state === 'manual') ?? [], [report]);
  const unresolvedManualItems = useMemo(() => manualItems.filter((item) => !item.manualResolution), [manualItems]);
  const selectableItems = useMemo(() => report?.items.filter((item) => isSelectable(item.state)) ?? [], [report]);
  const selectedSet = selection.runId === report?.runId
    ? selection.selectedIds
    : new Set(selectableItems.map((item) => item.sourceId));
  const selectedIds = selectableItems.filter((item) => selectedSet.has(item.sourceId)).map((item) => item.sourceId);
  const batches = run?.batches ?? [];

  const toggleSource = (sourceId: string, checked: boolean) => {
    if (!report) return;
    const nextSelected = new Set(selection.runId === report.runId ? selection.selectedIds : selectableItems.map((item) => item.sourceId));
    if (checked) nextSelected.add(sourceId);
    else nextSelected.delete(sourceId);
    setSelection({ runId: report.runId, selectedIds: nextSelected });
    persistSelection(workspace, report.runId, nextSelected);
  };

  const manualDraftKey = (sourceId: string) => `${workspace}:${report?.runId ?? ''}:${sourceId}`;
  const submitManualResolution = (sourceId: string) => {
    if (!report) return;
    const draft = manualDrafts[manualDraftKey(sourceId)];
    const kind = draft?.kind;
    const note = draft?.note.trim() ?? '';
    if (!kind || !note) return;
    void act(() => tencentdbApi.migrationResolveManual(workspace, report.runId, sourceId, kind, note));
  };

  return (
    <Flexbox gap={14} data-testid="tencentdb-migration-wizard">
      <Alert
        type="info"
        showIcon
        message="迁移是单向导入"
        description="验证通过前不会停用旧扩展，也不会删除任何 SQLite、会话或 Skill 原始文件。session-memory 不参与迁移。"
      />
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <Space wrap>
        <Button loading={loading} onClick={() => void act(() => tencentdbApi.migrationScan(workspace))}>
          1. 扫描来源
        </Button>
        <Button disabled={!canPreview || loading} onClick={() => void act(() => tencentdbApi.migrationPreview(workspace))}>
          2. 预览
        </Button>
        <Button type="primary" disabled={!canExecute || loading || selectedIds.length === 0} loading={loading} onClick={() => void act(() => tencentdbApi.migrationExecute(workspace, selectedIds))}>
          3. {report?.state === 'executing' ? '继续导入' : '执行导入'}
        </Button>
        <Button disabled={!canVerify || loading} loading={loading} onClick={() => void act(() => tencentdbApi.migrationVerify(workspace))}>
          4. 验证召回
        </Button>
        <Button danger disabled={!canArchive || loading} loading={loading} onClick={() => void act(() => tencentdbApi.migrationArchive(workspace))}>
          5. 归档旧链路
        </Button>
      </Space>
      {report ? (
        <Flexbox gap={10} data-testid="tencentdb-migration-report">
          <div>
            当前状态：{stateTag(report.state)}　来源项 {report.items.length}　待迁移记录 {report.totalCount}　人工处理 {report.manualCount}
          </div>
          {selectableItems.length ? (
            <Checkbox
              checked={selectedIds.length === selectableItems.length}
              indeterminate={selectedIds.length > 0 && selectedIds.length < selectableItems.length}
              onChange={(event) => {
                const nextSelected = event.target.checked ? selectableItems.map((item) => item.sourceId) : [];
                setSelection({ runId: report.runId, selectedIds: new Set(nextSelected) });
                persistSelection(workspace, report.runId, nextSelected);
              }}
            >
              选择全部待导入项
            </Checkbox>
          ) : null}
          <List
            size="small"
            bordered
            dataSource={report.items}
            renderItem={(item) => (
              <List.Item>
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  {isSelectable(item.state) ? (
                    <Checkbox
                      checked={selectedSet.has(item.sourceId)}
                      onChange={(event) => toggleSource(item.sourceId, event.target.checked)}
                    >
                      <Space>
                        <strong>{KIND_LABELS[item.sourceKind] ?? item.sourceKind}</strong>
                        {stateTag(item.state)}
                        <span>{item.migratedCount}/{item.itemCount}</span>
                      </Space>
                    </Checkbox>
                  ) : (
                    <Space>
                      <strong>{KIND_LABELS[item.sourceKind] ?? item.sourceKind}</strong>
                      {stateTag(item.state)}
                      <span>{item.migratedCount}/{item.itemCount}</span>
                    </Space>
                  )}
                  <span style={{ color: 'var(--ant-color-text-secondary)', wordBreak: 'break-all' }}>{item.sourcePath}</span>
                  {item.error ? <span style={{ color: 'var(--ant-color-error)' }}>{item.error}</span> : null}
                  {item.manualResolution ? (
                    <Space direction="vertical" size={2}>
                      <span><strong>人工处置：</strong>{MANUAL_RESOLUTION_LABELS[item.manualResolution.kind]}</span>
                      <span>备注：{item.manualResolution.note}</span>
                      <span>处理时间：{item.manualResolution.resolvedAt}</span>
                    </Space>
                  ) : item.state === 'manual' ? (() => {
                    const draft = manualDrafts[manualDraftKey(item.sourceId)] ?? { note: '' };
                    return (
                      <Space direction="vertical" size={6} style={{ width: '100%' }}>
                        <Radio.Group
                          value={draft.kind}
                          onChange={(event) => setManualDrafts((current) => ({
                            ...current,
                            [manualDraftKey(item.sourceId)]: { ...draft, kind: event.target.value as TencentdbManualResolutionKind },
                          }))}
                        >
                          <Space direction="vertical" size={2}>
                            <Radio value="external_completed">已在外部完成迁移</Radio>
                            <Radio value="explicit_waived">明确豁免并保留旧数据</Radio>
                          </Space>
                        </Radio.Group>
                        <Input.TextArea
                          rows={2}
                          placeholder="填写处理备注"
                          value={draft.note}
                          onChange={(event) => setManualDrafts((current) => ({
                            ...current,
                            [manualDraftKey(item.sourceId)]: { ...draft, note: event.target.value },
                          }))}
                        />
                        <Button
                          type="primary"
                          disabled={!draft.kind || !draft.note.trim() || loading}
                          onClick={() => submitManualResolution(item.sourceId)}
                        >
                          确认人工处置
                        </Button>
                      </Space>
                    );
                  })() : null}
                </Space>
              </List.Item>
            )}
          />
          {batches.length ? (
            <Flexbox gap={6} data-testid="tencentdb-migration-batches">
              <strong>迁移批次</strong>
              <List
                size="small"
                bordered
                dataSource={batches}
                renderItem={(batch) => (
                  <List.Item>
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <Space wrap>
                        <span style={{ wordBreak: 'break-all' }}>{batch.sourceId}</span>
                        <Tag color={batch.errors.length ? 'error' : batch.retryable ? 'processing' : 'success'}>
                          {batch.errors.length ? '失败' : batch.retryable ? '执行中' : `已导入 ${batch.count}`}
                        </Tag>
                      </Space>
                      {batch.targetId ? <span style={{ color: 'var(--ant-color-text-secondary)', wordBreak: 'break-all' }}>目标：{batch.targetId}</span> : null}
                      {batch.errors.map((message, index) => <span key={`${index}-${message}`} style={{ color: 'var(--ant-color-error)' }}>{message}</span>)}
                    </Space>
                  </List.Item>
                )}
              />
            </Flexbox>
          ) : null}
          {unresolvedManualItems.length ? <Alert type="warning" showIcon message={`有 ${unresolvedManualItems.length} 项尚未完成人工处置`} /> : null}
          {run.verification ? (
            <Alert
              type={run.verification.passed ? 'success' : 'warning'}
              showIcon
              message={run.verification.passed ? 'Gateway、知识构建、数量、抽样查询和 Pi 召回均已通过' : '验证未通过，旧链路保持启用'}
              description={run.verification.errors.length ? run.verification.errors.join('；') : undefined}
            />
          ) : null}
        </Flexbox>
      ) : (
        <div data-testid="tencentdb-migration-empty">尚未扫描。扫描只读检查，不会修改旧数据。</div>
      )}
    </Flexbox>
  );
}
