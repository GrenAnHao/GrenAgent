import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Input, Select, DatePicker } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { agentDataApi } from '../../lib/agentData';
import type { AuditExport, AuditQuery, AuditView, DiagnosticItem, DiagnosticReport, ResourceNavigation, ResourceRef } from '../../../electron/agentData/operationsContracts';
import type { WikiReindexResult } from '../../../electron/agentData/wikiContracts';
import { styles } from './agentDataStyles';
import { operationsStyles as ops } from './operationsStyles';
import { redact, resourceNavigation } from './operationsPresentation';
export { redact } from './operationsPresentation';

interface Props {
  visible?: boolean; navigation?: { resource?: ResourceRef; request?: number }; resourceFilter?: ResourceRef; selectionRequest?: number;
  onNavigate?(navigation: ResourceNavigation): void; onRefresh?(): Promise<void> | void;
}
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const resourceKey = (resource?: ResourceRef) => resource ? `${resource.type}:${resource.id}` : '';
const uniqueEvents = (items: AuditView[]) => [...new Map(items.map((item) => [item.id, item])).values()];

export function AuditDiagnosticsPanel({ visible = true, navigation, resourceFilter, selectionRequest, onNavigate, onRefresh }: Props) {
  const [tab, setTab] = useState<'audit' | 'diagnostics'>('audit');
  const resource = navigation?.resource ?? resourceFilter;
  const request = navigation?.request ?? selectionRequest;
  useEffect(() => { if (resource || request !== undefined) setTab('audit'); }, [resourceKey(resource), request]);
  return <section data-testid="audit-diagnostics-panel" className={`${ops.root} ${ops.auditRoot}`}>
    <div className={styles.sectionHeading}><h3 className={styles.heading}>审计与诊断</h3><span className={styles.hint}>查看记录与运行状态</span></div>
    <div role="tablist" aria-label="审计与诊断" className={ops.subnav}>
      <button type="button" role="tab" aria-selected={tab === 'audit'} className={`${styles.actionButton} ${tab === 'audit' ? ops.selectedTab : ''}`} onClick={() => setTab('audit')}>操作记录</button>
      <button type="button" role="tab" aria-selected={tab === 'diagnostics'} className={`${styles.actionButton} ${tab === 'diagnostics' ? ops.selectedTab : ''}`} onClick={() => setTab('diagnostics')}>运行诊断</button>
    </div>
    <div hidden={tab !== 'audit'} role="tabpanel" aria-label="操作记录" className={ops.scrollPanel}><AuditRecords visible={visible && tab === 'audit'} resourceFilter={resource} selectionRequest={request} onNavigate={onNavigate} /></div>
    <div hidden={tab !== 'diagnostics'} role="tabpanel" aria-label="运行诊断" className={ops.scrollPanel}><Diagnostics visible={visible && tab === 'diagnostics'} onNavigate={onNavigate} onRefresh={onRefresh} /></div>
  </section>;
}

function AuditRecords({ visible, resourceFilter, selectionRequest, onNavigate }: Pick<Props, 'resourceFilter' | 'selectionRequest' | 'onNavigate'> & { visible: boolean }) {
  const [action, setAction] = useState('');
  const [resourceType, setResourceType] = useState<ResourceRef['type'] | ''>(resourceFilter?.type ?? '');
  const [resourceId, setResourceId] = useState(resourceFilter?.id ?? '');
  const [fromDate, setFromDate] = useState<Dayjs | null>(null);
  const [toDate, setToDate] = useState<Dayjs | null>(null);
  const [rows, setRows] = useState<AuditView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string>();
  const [error, setError] = useState<string>();
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [exportSnapshot, setExportSnapshot] = useState<{ filterKey: string; value: AuditExport }>();
  const [exporting, setExporting] = useState(false);
  const [transferError, setTransferError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const epoch = useRef(0);
  const exportEpoch = useRef(0);
  const pageCount = useRef(1);
  const loadedSignature = useRef<string | undefined>(undefined);
  const busy = useRef(false);
  const firstRow = useRef<HTMLTableRowElement>(null);
  const scrollPending = useRef(false);
  const query = useMemo<AuditQuery>(() => ({
    ...(action.trim() ? { action: action.trim() } : {}),
    ...(resourceType && resourceId.trim() ? { resource: { type: resourceType, id: resourceId.trim() } } : {}),
    ...(fromDate ? { from: fromDate.startOf('day').valueOf() } : {}),
    ...(toDate ? { to: toDate.endOf('day').valueOf() } : {}),
  }), [action, resourceType, resourceId, fromDate, toDate]);
  const signature = JSON.stringify(query);
  const filterKey = JSON.stringify([action, resourceType, resourceId, fromDate?.format('YYYY-MM-DD') ?? null, toDate?.format('YYYY-MM-DD') ?? null]);
  const current = useRef({ signature, filterKey, visible }); current.current = { signature, filterKey, visible };
  const valid = (request: number) => request === epoch.current && current.current.visible && current.current.signature === signature;
  const filterError = resourceType && !resourceId.trim() ? '请输入资源 ID，资源筛选需要类型与 ID'
    : query.from !== undefined && query.to !== undefined && query.from > query.to ? '开始日期不能晚于结束日期' : undefined;
  const exported = !filterError && exportSnapshot?.filterKey === filterKey ? exportSnapshot.value : undefined;

  useEffect(() => {
    exportEpoch.current++;
    setExportSnapshot(undefined); setExporting(false); setTransferError(undefined); setNotice(undefined);
  }, [filterKey]);

  useEffect(() => {
    if (!resourceFilter && selectionRequest === undefined) return;
    setResourceType(resourceFilter?.type ?? ''); setResourceId(resourceFilter?.id ?? '');
    setAction(''); setFromDate(null); setToDate(null);
    scrollPending.current = true;
    setRefreshRequest((value) => value + 1);
  }, [resourceKey(resourceFilter), selectionRequest]);

  useEffect(() => {
    const request = ++epoch.current;
    exportEpoch.current++;
    setExporting(false); setTransferError(undefined); setNotice(undefined);
    busy.current = false; setLoadingMore(false);
    if (loadedSignature.current !== signature) {
      loadedSignature.current = signature; pageCount.current = 1;
      setRows([]); setLoaded(false); setNextCursor(undefined);
    }
    if (!visible || filterError) { setLoading(false); return; }
    setLoading(true); setError(undefined); busy.current = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          let cursor: string | undefined;
          let results: AuditView[] = [];
          const seen = new Set<string>();
          for (let page = 0; page < pageCount.current; page++) {
            const result = await agentDataApi.audits.query({ ...query, ...(cursor ? { cursor } : {}), limit: 50 });
            if (!valid(request)) return;
            results = results.concat(result.items); cursor = result.nextCursor;
            if (!cursor) break;
            if (seen.has(cursor)) throw new Error('审计分页游标未前进，请刷新记录');
            seen.add(cursor);
          }
          if (!valid(request)) return;
          setRows(uniqueEvents(results)); setNextCursor(cursor); setLoaded(true);
        } catch (cause) { if (valid(request)) setError(message(cause)); }
        finally { if (valid(request)) { setLoading(false); busy.current = false; } }
      })();
    }, 150);
    return () => { clearTimeout(timer); epoch.current++; exportEpoch.current++; };
  }, [signature, visible, refreshRequest, filterError]);

  useEffect(() => {
    if (visible && loaded && scrollPending.current && firstRow.current) { firstRow.current.scrollIntoView?.({ block: 'nearest' }); scrollPending.current = false; }
  }, [rows, loaded, visible]);

  const loadMore = async () => {
    if (!visible || filterError || busy.current || !nextCursor) return;
    const request = epoch.current; const cursor = nextCursor;
    busy.current = true; setLoadingMore(true); setError(undefined);
    try {
      const result = await agentDataApi.audits.query({ ...query, cursor, limit: 50 });
      if (!valid(request)) return;
      if (result.nextCursor === cursor) throw new Error('审计分页游标未前进，请刷新记录');
      setRows((items) => uniqueEvents([...items, ...result.items])); setNextCursor(result.nextCursor); pageCount.current++;
    } catch (cause) { if (valid(request)) setError(message(cause)); }
    finally { if (valid(request)) { busy.current = false; setLoadingMore(false); } }
  };
  const exportFilter = async () => {
    if (!visible || exporting || filterError) return;
    const request = ++exportEpoch.current; const scope = filterKey;
    setExporting(true); setTransferError(undefined); setNotice(undefined);
    try {
      const result = await agentDataApi.audits.export(query);
      if (request !== exportEpoch.current || !current.current.visible || current.current.filterKey !== scope) return;
      setExportSnapshot({ filterKey: scope, value: { items: redact(result.items.slice(0, 500)) as AuditView[], limit: 500, truncated: result.truncated || result.items.length > 500 } });
    } catch (cause) { if (request === exportEpoch.current && current.current.visible) setTransferError(message(cause)); }
    finally { if (request === exportEpoch.current) setExporting(false); }
  };
  const copy = async (value: unknown) => {
    if (!current.current.visible) return;
    const request = exportEpoch.current;
    try {
      await navigator.clipboard.writeText(JSON.stringify(redact(value), null, 2));
      if (request === exportEpoch.current && current.current.visible) { setNotice('已复制脱敏记录'); setTransferError(undefined); }
    } catch (cause) { if (request === exportEpoch.current && current.current.visible) setTransferError(`复制失败：${message(cause)}`); }
  };
  const download = () => {
    if (!exported || !current.current.visible || current.current.filterKey !== filterKey) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(redact(exported), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'agent-audit.json'; link.click(); URL.revokeObjectURL(url);
  };

  return <div className={ops.stack}>
    <div className={ops.filters}>
      <label>动作<Input aria-label="审计动作" placeholder="如 wiki.ingest" value={action} onChange={(e) => setAction(e.target.value)} /></label>
      <label>资源类型<Select aria-label="审计资源类型" value={resourceType} onChange={(value) => setResourceType(value as ResourceRef['type'] | '')} style={{ width: '100%' }} options={[
        { value: '', label: '全部资源' },
        { value: 'wiki', label: '知识库' },
        { value: 'project', label: '项目' },
        { value: 'memory', label: '记忆' }
      ]} /></label>
      <label>资源 ID<Input aria-label="审计资源ID" value={resourceId} disabled={!resourceType} onChange={(e) => setResourceId(e.target.value)} /></label>
      <label>开始日期<DatePicker aria-label="开始日期" value={fromDate} onChange={(date) => setFromDate(date)} style={{ width: '100%' }} /></label>
      <label>结束日期<DatePicker aria-label="结束日期" value={toDate} onChange={(date) => setToDate(date)} style={{ width: '100%' }} /></label>
      <div className={ops.filterActions}>
        <button type="button" className={styles.actionButton} disabled={!visible || loading || loadingMore} onClick={() => setRefreshRequest((value) => value + 1)}>刷新记录</button>
        <button type="button" className={styles.actionButton} disabled={!visible || exporting || !!filterError} onClick={() => void exportFilter()}>{exporting ? '正在导出…' : '导出当前筛选'}</button>
      </div>
    </div>
    <p className={styles.hint}>日期按本地时区整日筛选。记录只读；导出仅限当前筛选，最多 500 条，复制与下载均已脱敏。</p>
    {filterError || error ? <div role="alert" className={styles.error}>{filterError || error}{loaded ? '（保留上次结果）' : ''}</div> : null}
    {transferError ? <div role="alert" className={styles.error}>{transferError}</div> : null}
    {notice ? <p role="status" className={styles.hint}>{notice}</p> : null}
    {loading ? <p className={styles.hint}>{loaded ? '正在刷新记录…' : '正在加载操作记录…'}</p> : null}
    {loaded && !rows.length && !error ? <div className={styles.state}>暂无操作记录</div> : null}
    {rows.length ? <div className={styles.panelCard}><table className={`${styles.table} ${ops.auditTable}`}><thead><tr><th>操作摘要</th><th>关联资源</th><th>时间</th><th>详情</th></tr></thead><tbody>{rows.map((event, index) => {
      const safe = redact(event) as AuditView;
      return <tr key={event.id} ref={index === 0 ? firstRow : undefined}>
        <td>{safe.summary}<div className={styles.hint}>{safe.action}</div></td>
        <td>{safe.resourceName ?? (safe.resource ? `资源已移除（${safe.resource.id}）` : '未关联资源')}{event.resource && onNavigate ? <div><button type="button" className={styles.actionButton} onClick={() => onNavigate(resourceNavigation(event.resource!))}>查看资源</button></div> : null}</td>
        <td>{new Date(event.createdAt).toLocaleString()}</td>
        <td className={ops.auditDetail}><details><summary>展开详情</summary><pre>{JSON.stringify(safe.detail, null, 2)}</pre></details><button type="button" className={styles.actionButton} onClick={() => void copy(safe)}>复制记录</button></td>
      </tr>;
    })}</tbody></table></div> : null}
    {nextCursor ? <button type="button" className={styles.actionButton} disabled={!visible || !!filterError || loading || loadingMore} onClick={() => void loadMore()}>{loadingMore ? '正在加载…' : '加载更多记录'}</button> : null}
    {loaded ? <p className={styles.hint}>已加载 {rows.length} 条记录</p> : null}
    {exported ? <div className={styles.card}>
      <p>已准备 {exported.items.length} 条脱敏记录；{exported.truncated ? '最多 500 条，结果已截断' : '最多 500 条，本次结果完整'}。</p>
      <div className={ops.actions}><button type="button" className={styles.actionButton} onClick={() => void copy(exported)}>复制导出JSON</button><button type="button" className={styles.actionButton} onClick={download}>下载JSON</button></div>
    </div> : null}
  </div>;
}

function Diagnostics({ visible, onNavigate, onRefresh }: Pick<Props, 'onNavigate' | 'onRefresh'> & { visible: boolean }) {
  const [report, setReport] = useState<DiagnosticReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [category, setCategory] = useState('');
  const [resource, setResource] = useState('');
  const [target, setTarget] = useState<DiagnosticItem>();
  const [result, setResult] = useState<WikiReindexResult>();
  const [mutationError, setMutationError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [openBusy, setOpenBusy] = useState<string>();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [guide, setGuide] = useState<DiagnosticItem>();
  const epoch = useRef(0); const mutationEpoch = useRef(0); const openEpoch = useRef(0); const busyRef = useRef(false);
  const current = useRef({ visible, target: target?.id }); current.current = { visible, target: target?.id };

  const check = async () => {
    if (!current.current.visible) return;
    const request = ++epoch.current; setLoading(true); setError(undefined);
    try {
      const next = await agentDataApi.checks.check();
      if (request === epoch.current && current.current.visible) setReport(next);
    } catch (cause) { if (request === epoch.current && current.current.visible) setError(message(cause)); }
    finally { if (request === epoch.current && current.current.visible) setLoading(false); }
  };
  useEffect(() => {
    mutationEpoch.current++; openEpoch.current++; busyRef.current = false; setBusy(false); setOpenBusy(undefined); setMutationError(undefined); setResult(undefined);
    if (visible) void check();
    return () => { epoch.current++; mutationEpoch.current++; openEpoch.current++; };
  }, [visible]);
  const beginReindex = (item: DiagnosticItem) => {
    if (!visible || busyRef.current || item.resource?.type !== 'wiki') return;
    mutationEpoch.current++; setTarget(item); setResult(undefined); setMutationError(undefined);
  };
  const closeReindex = () => { if (!busyRef.current) { mutationEpoch.current++; setTarget(undefined); } };
  const reindex = async () => {
    if (!target || target.resource?.type !== 'wiki' || busyRef.current || !visible) return;
    const stable = target; const kbId = target.resource.id; const request = mutationEpoch.current;
    const valid = () => request === mutationEpoch.current && current.current.visible && current.current.target === stable.id;
    busyRef.current = true; setBusy(true); setMutationError(undefined);
    try {
      const next = await agentDataApi.wiki.libraries.reindex(kbId);
      if (!valid()) return;
      setResult(next); await check();
      if (valid()) await onRefresh?.();
    } catch (cause) { if (valid()) setMutationError(message(cause)); }
    finally { if (valid()) { busyRef.current = false; setBusy(false); } }
  };
  const open = async (item: DiagnosticItem) => {
    if (!visible || openBusy) return;
    const request = ++openEpoch.current;
    setOpenBusy(item.id); setRowErrors((errors) => ({ ...errors, [item.id]: '' }));
    try { await agentDataApi.checks.open(item.id); }
    catch (cause) { if (request === openEpoch.current && current.current.visible) setRowErrors((errors) => ({ ...errors, [item.id]: message(cause) })); }
    finally { if (request === openEpoch.current && current.current.visible) setOpenBusy(undefined); }
  };
  const items = report?.items.filter((item) => (!resource || resourceKey(item.resource) === resource)
    && (!category || (item.resource?.type === 'project' ? 'codegraph' : item.resource?.type ?? item.id.split(':')[0]) === category)) ?? [];
  const resourceOptions = [...new Map(report?.items.filter((item) => item.resource).map((item) => [resourceKey(item.resource), item.resource!]) ?? []).entries()];
  const stateLabel = { ok: '正常', action_required: '需要处理', unchecked: '未检查' };
  return <div className={ops.stack}>
    <div className={styles.toolbar}>
      <Select aria-label="诊断分类" value={category} onChange={(value) => setCategory(value)} style={{ width: 200 }} options={[
        { value: '', label: '全部分类' },
        { value: 'wiki', label: '知识库' },
        { value: 'codegraph', label: '代码索引' },
        { value: 'memory', label: '记忆' },
        { value: 'runtime', label: '运行服务' }
      ]} />
      <Select aria-label="诊断资源" value={resource} onChange={(value) => setResource(value)} style={{ width: 200 }} options={[
        { value: '', label: '全部资源' },
        ...resourceOptions.map(([key, value]) => ({ value: key, label: value.id }))
      ]} />
      <button type="button" className={styles.actionButton} disabled={!visible || loading || busy} onClick={() => void check()}>{loading ? '正在检查…' : '重新检查'}</button>
    </div>
    <p className={styles.hint}>检查只读取状态，不会自动调用模型、重建索引或安装工具。</p>
    {report ? <p className={styles.hint}>检查时间：{new Date(report.checkedAt).toLocaleString()}{error ? ' · 上次结果，可能已过期' : ''}</p> : !loading && !error ? <p className={styles.hint}>尚未检查</p> : null}
    {error ? <div role="alert" className={styles.error}>{error}</div> : null}
    {report && !items.length ? <p className={styles.hint}>{report.items.length ? '没有匹配的诊断项目' : '没有返回诊断项目，状态尚未确认'}</p> : null}
    {items.length ? <div className={styles.panelCard}>{items.map((item) => <article key={item.id} className={ops.diagnostic} aria-label={item.message}>
      <div className={ops.actions}><span className={`${styles.statusTag} ${item.state === 'ok' ? ops.okay : item.state === 'action_required' ? ops.warning : ops.unchecked}`}>{stateLabel[item.state]}</span><strong>{String(redact(item.message))}</strong></div>
      <p className={styles.hint}>{item.resource ? `${item.resource.type} · ${item.resource.id}` : item.id} · {new Date(item.checkedAt).toLocaleString()}</p>
      <div className={ops.actions}>
        {item.resource && onNavigate ? <button type="button" className={styles.actionButton} onClick={() => onNavigate(resourceNavigation(item.resource!))}>查看关联资源</button> : null}
        {item.action === 'open_file' ? <button type="button" className={styles.actionButton} disabled={!!openBusy} onClick={() => void open(item)}>打开问题文件</button> : null}
        {item.action === 'reindex_wiki' && item.resource?.type === 'wiki' ? <button type="button" className={styles.actionButton} disabled={busy} onClick={() => beginReindex(item)}>重建页面清单</button> : null}
        {item.action === 'configure_codegraph' ? <button type="button" className={styles.actionButton} onClick={() => setGuide(item)}>查看配置说明</button> : null}
      </div>
      {rowErrors[item.id] ? <div role="alert" className={styles.inlineError}>{rowErrors[item.id]}</div> : null}
    </article>)}</div> : null}
    {guide ? <div className={styles.card}><p>请先在本机配置 CodeGraph CLI，并在项目代码页检查连接与索引状态。这里不会自动安装或执行修复。</p>{onNavigate ? <button type="button" className={styles.actionButton} onClick={() => onNavigate({ view: 'code', ...(guide.resource?.type === 'project' ? { workspace: guide.resource.id } : {}) })}>前往代码配置</button> : null}</div> : null}
    <Modal open={visible && !!target} title="重建页面清单" closable={!busy} keyboard={!busy} mask={{ closable: !busy }} onCancel={closeReindex} footer={<div className={ops.actions}>
      <button type="button" className={styles.actionButton} disabled={busy} onClick={closeReindex}>关闭</button>
      {!result ? <button type="button" className={styles.actionButton} disabled={busy} onClick={() => void reindex()}>确认重建</button> : null}
    </div>}>
      <p>重新扫描知识库页面并重建检索清单；不调用模型、不修改正文，不创建后台模型任务。</p>
      <p>知识库 ID：{target?.resource?.id}</p>
      {mutationError ? <div role="alert" className={styles.error}>{mutationError}</div> : null}
      {result ? <><p>扫描完成：{result.pages} 个页面，{result.diagnostics.length} 个问题文件。</p><ul>{result.diagnostics.map((item, index) => <li key={`${item.path}:${index}`}>{item.path}：{String(redact(item.message))}</li>)}</ul></> : null}
    </Modal>
  </div>;
}
