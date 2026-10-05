import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Input, Modal, Radio, Select, Spin, Typography } from 'antd';
import { agentDataApi, type ManagedMemoryRecord, type MemoryFilter, type MemoryItem, type MemoryLevel, type MemoryOverview, type ResourceNavigation } from '../../lib/agentData';
import { pathsEquivalent } from '../../lib/pathUtils';
import { useProjectOptions } from './useProjectOptions';
import { useAgentDataTaskMonitor } from './AgentDataTaskProvider';
import { useMemoryBrowser } from './useMemoryBrowser';
import { MemoryDetail, type MemoryDetailProps } from './MemoryDetail';
import { MemoryList } from './MemoryList';
import { MemoryEditor, type MemoryEditorHandle } from './MemoryEditor';
import { useAskConfirm } from '../../components/askConfirm';
import { memoryLevelLabels } from './memoryPresentation';
import { PageHeader } from './workbench/PageHeader';
import { PageBanner } from './workbench/PageBanner';
import { SplitPane } from './workbench/SplitPane';
import { workbenchStyles as w } from './workbench/workbenchStyles';
import { memoryStyles as m } from './memoryStyles';

interface MemoryPanelProps {
  userId?: string;
  /** 仅用于首次打开；切换聊天不会重设筛选器。 */
  initialProject?: string;
  visible?: boolean;
  /** 统一刷新令牌；变化时重新读取列表与总数。 */
  refreshToken?: number;
  navigation?: Extract<ResourceNavigation, { view: 'memory' }>;
  navigationRequest?: number;
  onOpenSession?(cwd: string, path: string): void | Promise<void>;
}
interface Selection { userId: string; kind: MemoryItem['kind']; id: string; snippet?: string }
interface DetailState { key: string; value?: MemoryDetailProps['value']; loading: boolean; error?: string }
type FocusRequest = { kind: 'row'; id?: string } | { kind: 'edit' | 'new' | 'detail' };
type Group = '0' | '1' | '2' | '3' | 'conversation';
const selectionKey = (selection?: Selection) => selection ? JSON.stringify([selection.userId, selection.kind, selection.id]) : '';

export function MemoryPanel({ userId = 'local', initialProject, visible = true, refreshToken = 0, navigation, navigationRequest = 0, onOpenSession }: MemoryPanelProps) {
  const ask = useAskConfirm();
  const projects = useProjectOptions();
  const monitor = useAgentDataTaskMonitor();
  const [project, setProject] = useState(() => {
    const found = initialProject && projects.find((option) => pathsEquivalent(option.cwd, initialProject));
    return found ? `project:${found.cwd}` : '';
  });
  const [group, setGroup] = useState<Group>('2');
  const [query, setQuery] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const kind: MemoryItem['kind'] = group === 'conversation' ? 'conversation' : 'memory';
  const level = group === 'conversation' ? undefined : Number(group) as MemoryLevel;
  const [overview, setOverview] = useState<{ userId: string; value?: MemoryOverview; error?: string }>({ userId });
  const [selected, setSelected] = useState<Selection>();
  const [detail, setDetail] = useState<DetailState>({ key: '', loading: false });
  const [editor, setEditor] = useState<{ userId: string; record?: ManagedMemoryRecord; trigger: 'edit' | 'new'; unavailable?: boolean }>();
  const [removed, setRemoved] = useState<string[]>([]);
  const [notice, setNotice] = useState<string>();
  const [deleteError, setDeleteError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [focusRequest, setFocusRequest] = useState<FocusRequest>();
  const [navigationVersion, setNavigationVersion] = useState(0);
  const [editorVersion, setEditorVersion] = useState(0);
  const editorHandle = useRef<MemoryEditorHandle>(null);
  const handledNavigation = useRef<string | undefined>(undefined);
  const navigatedSelection = useRef<string | undefined>(undefined);
  const navigationKey = navigation ? JSON.stringify([userId, navigation.id, navigation.mode, navigationRequest]) : '';
  const currentNavigation = useRef(navigationKey);
  currentNavigation.current = navigationKey;
  const root = useRef<HTMLElement>(null);
  const activeSelection = selected?.userId === userId ? selected : undefined;
  const key = selectionKey(activeSelection);
  const current = useRef({ userId, visible, key, editing: !!editor, mounted: true });
  current.current = { userId, visible, key, editing: !!editor, mounted: current.current.mounted };
  const detailEpoch = useRef(0);
  const deleteRuntime = useRef({ userId, epoch: 0, busy: false });
  if (deleteRuntime.current.userId !== userId) deleteRuntime.current = { userId, epoch: deleteRuntime.current.epoch + 1, busy: false };
  const filter = useMemo<MemoryFilter>(() => project === 'global' ? { scope: 'global' } : project.startsWith('project:') ? { scope: 'project', projectId: project.slice('project:'.length) } : { scope: 'all' }, [project]);
  const reloadVersion = monitor.watchedTaskVersion + refreshVersion + refreshToken;
  const browser = useMemoryBrowser({ userId, filter, query, kind, level, visible, reloadVersion });
  const items = browser.items.filter((item) => item.kind !== 'memory' || !removed.includes(item.record.id));
  const activeDetail = detail.key === key ? detail : undefined;
  const locked = !!editor || deleting;
  const refresh = () => setRefreshVersion((version) => version + 1);

  useEffect(() => {
    current.current.mounted = true;
    return () => { current.current.mounted = false; detailEpoch.current++; deleteRuntime.current.epoch++; };
  }, []);
  useEffect(() => { setRemoved([]); setNotice(undefined); setDeleteError(undefined); setDeleting(false); }, [userId]);
  useEffect(() => {
    if (!visible || !navigation || handledNavigation.current === navigationKey) return;
    if ((!navigation.id && navigation.mode !== 'create') || deleteRuntime.current.busy) {
      handledNavigation.current = navigationKey;
      return;
    }
    if (navigation.id && editor?.userId === userId && editor.record?.id === navigation.id) {
      handledNavigation.current = navigationKey;
      return;
    }
    let cancelled = false;
    void (async () => {
      const ok = await (editorHandle.current?.confirmLeave() ?? true);
      if (cancelled || !ok || !current.current.visible || currentNavigation.current !== navigationKey) return;
      handledNavigation.current = navigationKey;
      detailEpoch.current++;
      setNotice(undefined); setDeleteError(undefined);
      if (navigation.mode === 'create' && !navigation.id) {
        setSelected(undefined); setEditorVersion((value) => value + 1); setEditor({ userId, trigger: 'new' });
      } else if (navigation.id) {
        setEditor(undefined); setProject(''); setQuery('');
        navigatedSelection.current = navigation.id;
        setSelected({ userId, kind: 'memory', id: navigation.id });
        setNavigationVersion((value) => value + 1);
      }
      setFocusRequest({ kind: 'detail' });
    })();
    return () => { cancelled = true; };
  }, [navigationKey, visible]);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setOverview((previous) => previous.userId === userId ? { ...previous, error: undefined } : { userId });
    void agentDataApi.memory.overview({ userId, includeOtherProjects: true }).then((value) => {
      if (!cancelled && current.current.userId === userId && current.current.visible) setOverview({ userId, value });
    }).catch((cause) => {
      if (!cancelled && current.current.userId === userId && current.current.visible) setOverview((previous) => ({ ...previous, error: String(cause) }));
    });
    return () => { cancelled = true; };
  }, [userId, visible, reloadVersion]);

  useEffect(() => {
    const epoch = ++detailEpoch.current;
    if (!visible || !activeSelection || deleteRuntime.current.busy) return;
    const target = activeSelection;
    const isCurrent = () => current.current.mounted && current.current.visible && current.current.key === key && detailEpoch.current === epoch && !deleteRuntime.current.busy;
    setDetail((previous) => ({ key, value: previous.key === key ? previous.value : undefined, loading: true }));
    const read = target.kind === 'memory' ? agentDataApi.memory.read({ userId, id: target.id }) : agentDataApi.memory.conversations.read({ userId, id: target.id });
    void read.then((record) => {
      if (!isCurrent()) return;
      if (!record) throw new Error('NOT_FOUND: 记录不存在');
      const value = target.kind === 'memory' ? { kind: 'memory' as const, record: record as ManagedMemoryRecord } : { kind: 'conversation' as const, record: { ...record as Extract<MemoryDetailProps['value'], { kind: 'conversation' }>['record'], ...(target.snippet === undefined ? {} : { snippet: target.snippet }) } };
      if (value.kind === 'memory' && navigatedSelection.current === target.id) {
        navigatedSelection.current = undefined;
        setGroup(String(value.record.level) as Group);
      }
      setDetail({ key, value, loading: false });
    }).catch((cause) => {
      if (!isCurrent()) return;
      const notFound = (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'NOT_FOUND') || String(cause).includes('NOT_FOUND');
      if (notFound) {
        if (target.kind === 'memory') setRemoved((previous) => [...previous, target.id]);
        setNotice('记录已被外部删除；未保存草稿仍保留。');
        setSelected(undefined);
        setEditor((previous) => previous?.userId === target.userId && previous.record?.id === target.id ? { ...previous, unavailable: true } : previous);
        if (!current.current.editing) setFocusRequest({ kind: 'row' });
      }
      setDetail((previous) => ({ ...previous, key, loading: false, error: notFound ? '记录已被外部删除；未保存草稿仍保留。' : String(cause) }));
    });
    return () => { detailEpoch.current++; };
  }, [key, visible, reloadVersion, navigationVersion]);

  useLayoutEffect(() => {
    if (!visible || !focusRequest || !root.current) return;
    const rows = Array.from(root.current.querySelectorAll<HTMLButtonElement>('[data-memory-row]'));
    const target = focusRequest.kind === 'row'
      ? rows.find((row) => row.dataset.memoryRow === focusRequest.id) ?? rows[0] ?? root.current.querySelector<HTMLButtonElement>('[data-memory-new]')
      : root.current.querySelector<HTMLElement>(focusRequest.kind === 'edit' ? '[data-memory-edit]' : focusRequest.kind === 'new' ? '[data-memory-new]' : '[data-memory-back], [aria-label="记忆正文"]');
    (target ?? rows[0] ?? root.current.querySelector<HTMLButtonElement>('[data-memory-new]'))?.focus();
    setFocusRequest(undefined);
  }, [focusRequest, visible, editor, key]);

  const choose = (item: MemoryItem) => {
    if (editor || deleteRuntime.current.busy) return;
    setSelected({ userId, kind: item.kind, id: item.record.id, ...(item.kind === 'conversation' ? { snippet: item.record.snippet } : {}) }); setDeleteError(undefined); setNotice(undefined); setFocusRequest({ kind: 'detail' });
  };
  const closeDetail = () => {
    if (deleteRuntime.current.busy) return;
    setFocusRequest({ kind: 'row', id: activeSelection?.id }); setSelected(undefined); setDeleteError(undefined);
  };
  const clearSelection = () => { setSelected(undefined); setNotice(undefined); setDeleteError(undefined); };
  const openCreate = () => { setEditor({ userId, trigger: 'new' }); setNotice(undefined); };
  const saved = (record: ManagedMemoryRecord) => {
    const inScope = filter.scope === 'all' || (filter.scope === 'global' ? record.scope === 'global' : record.scope === 'project' && !!record.sourceProjectId && pathsEquivalent(record.sourceProjectId, filter.projectId));
    const moved = record.level !== level && group !== 'conversation';
    // 层级由 moved 决定（会切到 record.level），matches 只判归属范围与搜索。
    const matches = inScope && (moved || level === record.level) && (!query.trim() || record.content.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    if (moved) setGroup(String(record.level) as Group);
    setNotice(moved ? (matches ? `已保存，已移到 L${record.level}` : `已保存，已移到 L${record.level}，但当前筛选不包含这条记忆。`) : matches ? '记忆已保存。' : '已保存，但当前筛选不包含这条记忆。');
    const next = { userId, kind: 'memory' as const, id: record.id };
    setSelected(next); setDetail({ key: selectionKey(next), value: { kind: 'memory', record }, loading: false });
    setFocusRequest({ kind: editor?.trigger ?? 'new' }); setEditor(undefined); refresh();
  };
  const remove = async () => {
    const value = activeDetail?.value;
    if (value?.kind !== 'memory' || deleteRuntime.current.busy) return;
    if (!(await ask({ title: '确认删除这条记忆？', content: '来源对话记录不会被删除。', danger: true }))) return;
    const target = { id: value.record.id, userId };
    const state = deleteRuntime.current;
    const epoch = ++state.epoch;
    const isCurrent = () => current.current.mounted && deleteRuntime.current === state && state.epoch === epoch && current.current.key === key;
    const index = items.findIndex((item) => item.record.id === target.id);
    const nextId = items[index + 1]?.record.id ?? items[index - 1]?.record.id;
    state.busy = true; setDeleting(true); setDeleteError(undefined);
    try {
      await agentDataApi.memory.delete({ userId: target.userId }, target.id);
      if (!isCurrent()) return;
      setRemoved((previous) => [...previous, target.id]); setSelected(undefined);
      setNotice('记忆已删除；来源对话记录未改动。'); setFocusRequest({ kind: 'row', id: nextId }); refresh();
    } catch (cause) { if (isCurrent()) setDeleteError(String(cause)); }
    finally { if (deleteRuntime.current === state && state.epoch === epoch && current.current.mounted) { state.busy = false; setDeleting(false); } }
  };
  const overviewValue = overview.userId === userId ? overview : undefined;
  const editorRecord = editor?.record && activeDetail?.value?.kind === 'memory' && editor.record.id === activeDetail.value.record.id ? activeDetail.value.record : editor?.record;
  const editing = !!editor && editor.trigger === 'edit';
  const detailOpen = !!activeSelection || editing;
  const levelTotal = kind === 'memory' ? overviewValue?.value?.byLevel[`L${level}`] ?? 0 : 0;
  const scopeName = filter.scope === 'global' ? '全局' : filter.scope === 'project' ? (projects.find((option) => pathsEquivalent(option.cwd, filter.projectId))?.name ?? '当前项目') : '';
  // 等级角标是全部项目的总数，不随归属筛选变化。筛选把这一层滤空时，不能再说「暂无记忆」。
  const hiddenByScope = kind === 'memory' && !query.trim() && scopeName !== '' && levelTotal > 0;
  const emptyDescription = query ? '暂无匹配记录' : hiddenByScope ? `${scopeName}范围内没有 L${level} 记忆。上方 L${level} 的 ${levelTotal} 是全部项目的总数。` : kind === 'memory' ? '暂无记忆' : '暂无对话记录';
  const showAllProjects = () => { setProject(''); clearSelection(); };
  const listPane = <div data-memory-list-pane>
    {browser.error ? <PageBanner type="error" items={[{ message: `${browser.loaded ? '刷新失败，已保留当前列表：' : '读取失败：'}${browser.error}` }]} /> : null}
    {browser.loading && !browser.loaded ? <Spin description="正在加载 Memory…" /> : !browser.loaded ? <Empty description={kind === 'memory' ? '记忆列表尚未读取成功' : '对话列表尚未读取成功'} /> : items.length === 0 ? <Empty description={emptyDescription}>{hiddenByScope ? <Button onClick={showAllProjects}>查看全部项目</Button> : null}</Empty> : null}
    {browser.refreshing ? <Typography.Text role="status" type="secondary" style={{ fontSize: 12 }}>正在刷新列表…</Typography.Text> : null}
    <MemoryList items={items} selectedId={activeSelection?.id} nextCursor={browser.nextCursor} refreshing={browser.refreshing} onSelect={choose} onLoadMore={browser.loadMore} />
  </div>;
  const mainPane = editing ? <MemoryEditor ref={editorHandle} key={JSON.stringify([editor!.userId, editor!.record?.id, editorVersion])} userId={userId} record={editorRecord} projects={projects} unavailable={editor!.userId === userId && editor!.unavailable} onUnavailable={() => { setSelected(undefined); setEditor((previous) => previous ? { ...previous, unavailable: true } : undefined); }} onSaved={saved} onCancel={() => { setFocusRequest({ kind: editor!.trigger }); setEditor(undefined); }} />
    : activeSelection ? <>
      <div className={m.toolbar}><Button data-memory-back className={m.backButton} disabled={deleting} onClick={closeDetail}>返回记忆列表</Button>{activeDetail?.error ? <Button onClick={refresh}>重试详情</Button> : null}{deleting ? <Typography.Text role="status">正在删除…</Typography.Text> : null}</div>
      {deleteError ? <PageBanner type="error" items={[{ message: deleteError }]} /> : null}
      {activeDetail?.error ? <PageBanner type="error" items={[{ message: activeDetail.error }]} /> : null}
      {activeDetail?.value ? <MemoryDetail value={activeDetail.value} visible={visible} onEdit={deleting ? undefined : () => { if (activeDetail.value?.kind === 'memory') { setEditor({ userId, record: activeDetail.value.record, trigger: 'edit' }); setFocusRequest({ kind: 'detail' }); } }} onDelete={deleting ? undefined : () => void remove()} onOpenSession={onOpenSession} /> : <Typography.Text type="secondary">{activeDetail?.loading ? '正在读取详情…' : '详情尚未读取成功'}</Typography.Text>}
    </> : <div className={w.empty}><Empty description="选择一条记录查看全文和来源" /></div>;
  return <section ref={root} className={m.root} data-testid="memory-panel">
    <PageHeader title="Memory" subtitle={`${overviewValue?.value?.total ?? '—'} 条记忆`} actions={<Button type="primary" data-memory-new disabled={locked} onClick={openCreate}>新增记忆</Button>} />
    <Radio.Group aria-label="记忆分组" optionType="button" value={group} disabled={locked} className={m.groups} onChange={(event) => { setGroup(event.target.value); clearSelection(); }}
      options={[
        ...(['0', '1', '2', '3'] as const).map((value) => ({ value, label: <span title="全部项目的总数">L{value}<span className={m.count}>{overviewValue?.value?.byLevel[`L${value}`] ?? '—'}</span></span> })),
        { value: 'conversation', label: '对话记录', className: m.gap },
      ]} />
    <PageBanner type="error" items={[
      ...(monitor.error ? [{ message: `任务状态读取失败：${monitor.error}` }] : []),
      ...(overviewValue?.error ? [{ source: '记忆总数', message: overviewValue.error }] : []),
    ]} />
    {notice ? <Typography.Text role="status">{notice}</Typography.Text> : null}
    <div className={`${w.panel} ${m.fill}`}>
      <div className={w.panelToolbar}>
        <Typography.Text type="secondary">{group === 'conversation' ? '对话记录只读。对话捕获没有全局层，按原始项目保存；此处仅查看，不支持编辑或删除。' : memoryLevelLabels[Number(group) as MemoryLevel]}</Typography.Text>
        <span className={w.spacer} />
        <Input aria-label="搜索记忆" placeholder="搜索内容" value={query} disabled={locked} onChange={(event) => { setQuery(event.target.value); clearSelection(); }} style={{ width: 200 }} />
        <Select aria-label="项目范围" value={project} disabled={locked} onChange={(value) => { setProject(value); clearSelection(); }} options={[
          { value: '', label: '全部项目' },
          { value: 'global', label: '全局' },
          ...(project.startsWith('project:') && !projects.some((option) => `project:${option.cwd}` === project) ? [{ value: project, label: '所选项目已不可用', disabled: true }] : []),
          ...projects.map((option) => ({ value: `project:${option.cwd}`, label: option.name })),
        ]} />
      </div>
      <SplitPane className={m.split} detailOpen={detailOpen} side={listPane} main={mainPane} />
    </div>
    <Modal open={editor?.trigger === 'new'} title="新增记忆" footer={null} destroyOnHidden onCancel={() => void (editorHandle.current?.confirmLeave() ?? Promise.resolve(true)).then((ok) => { if (ok) setEditor(undefined); })}>
      {editor?.trigger === 'new' ? <MemoryEditor ref={editorHandle} key={`new:${editorVersion}`} userId={userId} initialLevel={group === '1' || group === '3' ? Number(group) as 1 | 3 : 2} projects={projects} onSaved={saved} onCancel={() => setEditor(undefined)} /> : null}
    </Modal>
  </section>;
}
