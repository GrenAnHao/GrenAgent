import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, DatePicker, Empty, Flex, Input, Modal, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { agentDataApi } from '../../lib/agentData';
import type { AuditExport, AuditQuery, AuditView, DiagnosticItem, DiagnosticReport, ResourceNavigation, ResourceRef } from '../../../electron/agentData/operationsContracts';
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
const stateLabel = { ok: '正常', action_required: '需要处理', unchecked: '未检查' };
const stateColors = { ok: 'success', action_required: 'warning', unchecked: 'default' };
// antd 会为「恰好两个汉字且无图标」的按钮插入空格（关闭 → 关 闭），改变可访问名称与读屏结果。
const autoInsertSpace = false;

export function AuditDiagnosticsPanel({ visible = true, navigation, resourceFilter, selectionRequest, onNavigate, onRefresh }: Props) {
  const [tab, setTab] = useState<'audit' | 'diagnostics'>('audit');
  const resource = navigation?.resource ?? resourceFilter;
  const request = navigation?.request ?? selectionRequest;
  useEffect(() => { if (resource || request !== undefined) setTab('audit'); }, [resourceKey(resource), request]);
  return <section data-testid="audit-diagnostics-panel" className={`${ops.root} ${ops.auditRoot}`}>
    <div className={styles.sectionHeading} style={{ flex: '0 0 auto' }}><Typography.Title level={5} style={{ margin: 0 }}>审计与诊断</Typography.Title><Typography.Text type="secondary">查看记录与运行状态</Typography.Text></div>
    <Tabs id="audit-diagnostics" className={styles.bodyTabs} activeKey={tab} onChange={(key) => setTab(key as 'audit' | 'diagnostics')} items={[
      { key: 'audit', label: '操作记录', children: <div className={ops.scrollPanel}><AuditRecords visible={visible && tab === 'audit'} resourceFilter={resource} selectionRequest={request} onNavigate={onNavigate} /></div> },
      { key: 'diagnostics', label: '运行诊断', children: <div className={ops.scrollPanel}><Diagnostics visible={visible && tab === 'diagnostics'} onNavigate={onNavigate} /></div> },
    ]} />
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
  const safeRows = useMemo(() => rows.map((event) => redact(event) as AuditView), [rows]);

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
    if (!visible || !loaded || !scrollPending.current) return;
    const first = safeRows[0];
    const row = first ? document.querySelector<HTMLElement>(`tr[data-row-key="${first.id}"]`) : null;
    if (!row) return;
    row.scrollIntoView?.({ block: 'nearest' }); scrollPending.current = false;
  }, [safeRows, loaded, visible]);

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

  const columns: TableColumnsType<AuditView> = [
    { title: '操作摘要', key: 'summary', width: '34%', render: (_, event) => (
      <div>{event.summary}<div><Typography.Text type="secondary">{event.action}</Typography.Text></div></div>
    ) },
    { title: '关联资源', key: 'resource', width: '30%', render: (_, event) => (
      <>{event.resourceName ?? (event.resource ? `资源已移除（${event.resource.id}）` : '未关联资源')}
        {event.resource && onNavigate ? <div><Button size="small" onClick={() => onNavigate(resourceNavigation(event.resource!))}>查看资源</Button></div> : null}</>
    ) },
    { title: '时间', key: 'createdAt', width: 168, render: (_, event) => new Date(event.createdAt).toLocaleString() },
    { title: '详情', key: 'detail', width: 128, render: (_, event) => (
      <div className={ops.auditDetail}>
        <details><summary>展开详情</summary><pre>{JSON.stringify(event.detail, null, 2)}</pre></details>
        <Button size="small" onClick={() => void copy(redact(event))}>复制记录</Button>
      </div>
    ) },
  ];

  return <Flex vertical gap={12}>
    <Card size="small">
      <Flex wrap gap={12} align="flex-end">
        <Flex vertical gap={4}><Typography.Text type="secondary">动作</Typography.Text><Input aria-label="审计动作" placeholder="如 wiki.ingest" value={action} onChange={(e) => setAction(e.target.value)} style={{ width: 200 }} /></Flex>
        <Flex vertical gap={4}><Typography.Text type="secondary">资源类型</Typography.Text><Select aria-label="审计资源类型" value={resourceType} onChange={(value) => setResourceType(value as ResourceRef['type'] | '')} style={{ width: 160 }} options={[
          { value: '', label: '全部资源' },
          { value: 'wiki', label: '知识库' },
          { value: 'project', label: '项目' },
          { value: 'memory', label: '记忆' }
        ]} /></Flex>
        <Flex vertical gap={4}><Typography.Text type="secondary">资源 ID</Typography.Text><Input aria-label="审计资源ID" value={resourceId} disabled={!resourceType} onChange={(e) => setResourceId(e.target.value)} style={{ width: 200 }} /></Flex>
        <Flex vertical gap={4}><Typography.Text type="secondary">开始日期</Typography.Text><DatePicker aria-label="开始日期" value={fromDate} onChange={(date) => setFromDate(date)} /></Flex>
        <Flex vertical gap={4}><Typography.Text type="secondary">结束日期</Typography.Text><DatePicker aria-label="结束日期" value={toDate} onChange={(date) => setToDate(date)} /></Flex>
        <Space size={8} wrap style={{ marginInlineStart: 'auto' }}>
          <Button disabled={!visible || loading || loadingMore} onClick={() => setRefreshRequest((value) => value + 1)}>刷新记录</Button>
          <Button disabled={!visible || exporting || !!filterError} onClick={() => void exportFilter()}>{exporting ? '正在导出…' : '导出当前筛选'}</Button>
        </Space>
      </Flex>
    </Card>
    <Typography.Text type="secondary">日期按本地时区整日筛选。记录只读；导出仅限当前筛选，最多 500 条，复制与下载均已脱敏。</Typography.Text>
    {filterError || error ? <Alert type="error" showIcon title={`${filterError || error}${loaded ? '（保留上次结果）' : ''}`} /> : null}
    {transferError ? <Alert type="error" showIcon title={transferError} /> : null}
    {notice ? <Typography.Text type="success" role="status">{notice}</Typography.Text> : null}
    {loading ? <Typography.Text type="secondary">{loaded ? '正在刷新记录…' : '正在加载操作记录…'}</Typography.Text> : null}
    {loaded && !rows.length && !error ? <Empty description="暂无操作记录" /> : null}
    {rows.length ? <Table<AuditView>
      rowKey={(event) => event.id}
      size="small"
      tableLayout="fixed"
      pagination={false}
      columns={columns}
      dataSource={safeRows}
      locale={{ emptyText: '暂无操作记录' }}
    /> : null}
    {nextCursor ? <Button disabled={!visible || !!filterError || loading || loadingMore} onClick={() => void loadMore()}>{loadingMore ? '正在加载…' : '加载更多记录'}</Button> : null}
    {loaded ? <Typography.Text type="secondary">已加载 {rows.length} 条记录</Typography.Text> : null}
    {exported ? <Card size="small">
      <p>已准备 {exported.items.length} 条脱敏记录；{exported.truncated ? '最多 500 条，结果已截断' : '最多 500 条，本次结果完整'}。</p>
      <Space size={8} wrap><Button onClick={() => void copy(exported)}>复制导出JSON</Button><Button onClick={download}>下载JSON</Button></Space>
    </Card> : null}
  </Flex>;
}

function Diagnostics({ visible, onNavigate }: Pick<Props, 'onNavigate' | 'onRefresh'> & { visible: boolean }) {
  const [report, setReport] = useState<DiagnosticReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [category, setCategory] = useState('');
  const [resource, setResource] = useState('');
  const [openBusy, setOpenBusy] = useState<string>();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [guide, setGuide] = useState<DiagnosticItem>();
  const epoch = useRef(0); const openEpoch = useRef(0);
  const current = useRef({ visible }); current.current = { visible };

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
    openEpoch.current++; setOpenBusy(undefined);
    if (visible) void check();
    return () => { epoch.current++; openEpoch.current++; };
  }, [visible]);
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
  return <Flex vertical gap={12}>
    <Flex wrap gap={8}>
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
      <Button disabled={!visible || loading} onClick={() => void check()}>{loading ? '正在检查…' : '重新检查'}</Button>
    </Flex>
    <Typography.Text type="secondary">检查只读取状态，不会自动调用模型、重建索引或安装工具。</Typography.Text>
    {report ? <Typography.Text type="secondary">检查时间：{new Date(report.checkedAt).toLocaleString()}{error ? ' · 上次结果，可能已过期' : ''}</Typography.Text> : !loading && !error ? <Typography.Text type="secondary">尚未检查</Typography.Text> : null}
    {error ? <Alert type="error" showIcon title={error} /> : null}
    {report && !items.length ? <Typography.Text type="secondary">{report.items.length ? '没有匹配的诊断项目' : '没有返回诊断项目，状态尚未确认'}</Typography.Text> : null}
    {items.length ? <Flex vertical gap={8}>{items.map((item) => <Card key={item.id} size="small">
      <Flex wrap gap={8} align="center"><Tag color={stateColors[item.state]}>{stateLabel[item.state]}</Tag><Typography.Text strong>{String(redact(item.message))}</Typography.Text></Flex>
      <Typography.Text type="secondary">{item.resource ? `${item.resource.type} · ${item.resource.id}` : item.id} · {new Date(item.checkedAt).toLocaleString()}</Typography.Text>
      <Space size={8} wrap>
        {item.resource && onNavigate ? <Button size="small" onClick={() => onNavigate(resourceNavigation(item.resource!))}>查看关联资源</Button> : null}
        {item.action === 'open_file' ? <Button size="small" disabled={!!openBusy} onClick={() => void open(item)}>打开问题文件</Button> : null}
        {item.action === 'configure_codegraph' ? <Button size="small" onClick={() => setGuide(item)}>查看配置说明</Button> : null}
      </Space>
      {rowErrors[item.id] ? <Alert type="error" showIcon title={rowErrors[item.id]} /> : null}
    </Card>)}</Flex> : null}
    {guide ? <Card size="small"><p>请先在本机配置 CodeGraph CLI，并在项目代码页检查连接与索引状态。这里不会自动安装或执行修复。</p>{onNavigate ? <Button onClick={() => onNavigate({ view: 'code', ...(guide.resource?.type === 'project' ? { workspace: guide.resource.id } : {}) })}>前往代码配置</Button> : null}</Card> : null}
  </Flex>;
}
