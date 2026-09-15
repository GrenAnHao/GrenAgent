import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Select } from 'antd';
import { agentDataApi } from '../../../lib/agentData';
import type { WikiPage, WikiSource, WikiSourceRef, WikiTarget } from '../../../../electron/agentData/wikiContracts';
import { LazyMarkdown } from '../../chat/LazyMarkdown';
import { WikiDeleteDialog } from './WikiDeleteDialog';
import { wikiStyles as w } from './wikiStyles';

interface Props { kbId: string; page?: WikiPage; readOnly: boolean; visible?: boolean; confirmationVisible?: boolean; onSaved(page: WikiPage): void; onClose(): void; onDeleteRequested?(target: WikiTarget): void }
export interface WikiPageEditorHandle { confirmDiscard(): Promise<boolean>; isDirty(): boolean }

export const WikiPageEditor = forwardRef<WikiPageEditorHandle, Props>(function WikiPageEditor({ kbId, page, readOnly, visible = true, confirmationVisible = visible, onSaved, onClose, onDeleteRequested }, ref) {
  const [base, setBase] = useState(page);
  const [draftKbId, setDraftKbId] = useState(kbId);
  const [draftTitle, setTitle] = useState(page?.title ?? '');
  const [draftContent, setContent] = useState(page?.content ?? '');
  const [draftRefs, setRefs] = useState<WikiSourceRef[]>(page?.sourceRefs ?? []);
  const [sources, setSources] = useState<WikiSource[]>([]);
  const [sourceError, setSourceError] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WikiTarget>();
  const [snapshot, setSnapshot] = useState<{ ref: WikiSourceRef; source?: WikiSource; content?: string; error?: string }>();
  const [preview, setPreview] = useState(false);
  const discardResolver = useRef<((discard: boolean) => void) | undefined>(undefined);
  const sourceSequence = useRef(0);
  const documentSequence = useRef(0);
  const currentTarget = useRef({ kbId, pageId: page?.pageId });
  currentTarget.current = { kbId, pageId: page?.pageId };
  const mounted = useRef(true);
  const isCurrentDocument = (request: number) => mounted.current && request === documentSequence.current && currentTarget.current.kbId === kbId && currentTarget.current.pageId === page?.pageId;
  const dirty = draftTitle !== (base?.title ?? '') || draftContent !== (base?.content ?? '') || JSON.stringify(draftRefs) !== JSON.stringify(base?.sourceRefs ?? []);
  const dataKbId = base?.kbId ?? draftKbId;
  const applyPage = (next: WikiPage | undefined) => { documentSequence.current++; setSaving(false); setReloading(false); setBase(next); setDraftKbId(next?.kbId ?? kbId); setTitle(next?.title ?? ''); setContent(next?.content ?? ''); setRefs(next?.sourceRefs ?? []); };
  useEffect(() => {
    if (!dirty) applyPage(page);
  }, [page]);
  useEffect(() => { documentSequence.current++; setSaving(false); setReloading(false); setUnlocking(false); setSnapshot(undefined); setDeleteTarget(undefined); setConfirming(false); discardResolver.current?.(false); }, [kbId, page?.pageId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; documentSequence.current++; discardResolver.current?.(false); }; }, []);
  useEffect(() => {
    if (!confirmationVisible) { setConfirming(false); discardResolver.current?.(false); discardResolver.current = undefined; }
  }, [confirmationVisible]);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void agentDataApi.wiki.sources.list(dataKbId).then((next) => { if (!cancelled) { setSources(next); setSourceError(undefined); } }).catch((cause) => { if (!cancelled) setSourceError(String(cause)); });
    return () => { cancelled = true; sourceSequence.current++; };
  }, [dataKbId, visible]);
  const confirmDiscard = () => {
    if (saving) { setError('正在保存，请等待保存完成后再离开。'); return Promise.resolve(false); }
    if (reloading) { setError('正在重新载入，请等待读取完成后再离开。'); return Promise.resolve(false); }
    if (!dirty) return Promise.resolve(true);
    discardResolver.current?.(false);
    setConfirming(true);
    return new Promise<boolean>((resolve) => { discardResolver.current = resolve; });
  };
  useImperativeHandle(ref, () => ({ confirmDiscard, isDirty: () => dirty }));
  const settleDiscard = (discard: boolean) => { setConfirming(false); discardResolver.current?.(discard); discardResolver.current = undefined; };
  const close = async () => { if (await confirmDiscard()) onClose(); };
  const save = async () => {
    if (readOnly || saving || reloading || !visible || !draftTitle.trim()) return;
    const request = ++documentSequence.current;
    setSaving(true); setError(undefined);
    try {
      const input = { title: draftTitle.trim(), content: draftContent, sourceRefs: draftRefs };
      const saved = base
        ? await agentDataApi.wiki.pages.update(base.kbId, base.pageId, { ...input, expected: { revision: base.revision, contentHash: base.contentHash } })
        : await agentDataApi.wiki.pages.create(draftKbId, input);
      if (isCurrentDocument(request)) { applyPage(saved); setNotice(saved.locked ? '已保存并锁定，后续抽取不会覆盖人工内容。' : '已保存，未声明人工锁定。'); onSaved(saved); }
    } catch (cause) { if (isCurrentDocument(request)) setError(String(cause).includes('VERSION_CONFLICT') ? '页面已在其它位置修改；草稿已保留，请重新载入原版本后比较。' : String(cause)); }
    finally { if (isCurrentDocument(request)) setSaving(false); }
  };
  const reload = async () => {
    if (!base || saving || reloading) return;
    const target = base;
    const beforeConfirmation = documentSequence.current;
    if (!await confirmDiscard() || beforeConfirmation !== documentSequence.current || !mounted.current) return;
    const request = ++documentSequence.current;
    setReloading(true); setError(undefined);
    try {
      const next = await agentDataApi.wiki.pages.read(target.kbId, target.pageId);
      if (!isCurrentDocument(request)) return;
      if (next) { applyPage(next); setError(undefined); setNotice(undefined); }
      else setError('页面已被删除；当前草稿仍保留。');
    } catch (cause) { if (isCurrentDocument(request)) setError(String(cause)); }
    finally { if (isCurrentDocument(request)) setReloading(false); }
  };
  const setLocked = async (locked: boolean) => {
    if (!base || readOnly || saving || reloading || dirty || !draftRefs.length) return;
    const request = ++documentSequence.current;
    setSaving(true);
    try {
      const saved = await agentDataApi.wiki.pages.setLocked(base.kbId, base.pageId, locked, { revision: base.revision, contentHash: base.contentHash });
      if (!isCurrentDocument(request)) return;
      applyPage(saved); setUnlocking(false); setError(undefined); onSaved(saved);
    } catch (cause) { if (isCurrentDocument(request)) setError(String(cause)); }
    finally { if (isCurrentDocument(request)) setSaving(false); }
  };
  const readReference = async (sourceRef: WikiSourceRef) => {
    const request = ++sourceSequence.current;
    setSnapshot({ ref: sourceRef });
    try {
      const result = await agentDataApi.wiki.sources.read(dataKbId, sourceRef.sourceId, sourceRef.revision);
      if (sourceSequence.current === request) setSnapshot({ ref: sourceRef, source: result.source, content: result.content });
    } catch (cause) { if (sourceSequence.current === request) setSnapshot({ ref: sourceRef, error: String(cause) }); }
  };
  const referenceOptions = [...sources.map((source) => ({ sourceId: source.sourceId, revision: source.revision })), ...draftRefs]
    .filter((item, index, all) => all.findIndex((other) => other.sourceId === item.sourceId && other.revision === item.revision) === index)
    .map((sourceRef) => ({ value: JSON.stringify(sourceRef), label: `${sources.find((source) => source.sourceId === sourceRef.sourceId)?.name ?? sourceRef.sourceId} · r${sourceRef.revision}` }));

  return <section className={w.editor} aria-label="知识页面编辑器" onKeyDown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void close(); }
  }}>
    <div className={w.toolbar}><Button disabled={saving || reloading} onClick={() => void close()} aria-label="关闭页面详情">返回列表</Button><Button type="primary" disabled={readOnly || reloading || !draftTitle.trim()} loading={saving} onClick={() => void save()}>保存页面</Button><Button onClick={() => setPreview(!preview)}>{preview ? '编辑正文' : '预览页面'}</Button>{dirty ? <span role="status">未保存修改</span> : null}{reloading ? <span role="status">正在重新载入…</span> : null}</div>
    {readOnly ? <Alert type="warning" title="知识库正在删除或不可写，当前内容只读。" /> : null}
    {error ? <Alert type="error" title={error} showIcon /> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <label className={w.field}>标题<Input aria-label="页面标题" value={draftTitle} readOnly={readOnly || saving || reloading} onChange={(event) => setTitle(event.target.value)} /></label>
    <div hidden={preview}><label className={w.field}>Markdown 正文<Input.TextArea aria-label="Markdown 正文" rows={16} value={draftContent} readOnly={readOnly || saving || reloading} onChange={(event) => setContent(event.target.value)} /></label></div>
    <div hidden={!preview} className={`${w.document} ${w.preview}`}><LazyMarkdown prose={false}>{draftContent}</LazyMarkdown></div>
    <label className={w.field}>引用原始资料<Select mode="multiple" aria-label="页面来源引用" disabled={readOnly || saving || reloading} value={draftRefs.map((sourceRef) => JSON.stringify(sourceRef))} options={referenceOptions} onChange={(values: string[]) => setRefs(values.map((value) => JSON.parse(value) as WikiSourceRef))} placeholder="可不关联，或关联多份资料" /></label>
    {sourceError ? <Alert type="error" title={`资料列表：${sourceError}`} /> : null}
    {!draftRefs.length ? <div className={w.muted}><p>人工创建</p><p>先关联原始资料</p></div> : <div className={w.toolbar}>{draftRefs.map((sourceRef) => {
      const source = sources.find((item) => item.sourceId === sourceRef.sourceId);
      return <Button key={`${sourceRef.sourceId}:${sourceRef.revision}`} size="small" aria-label={`查看来源 ${source?.name ?? sourceRef.sourceId} r${sourceRef.revision}`} onClick={() => void readReference(sourceRef)}>{source?.name ?? sourceRef.sourceId} · r{sourceRef.revision}{source?.lifecycle === 'deleted' ? ' · 来源已删除' : ''}</Button>;
    })}</div>}
    <div className={w.muted}>{!base ? '人工保存后默认锁定。' : base.locked ? '已人工锁定；仍可继续人工编辑。' : '未声明人工锁定。'}{draftRefs.length > 1 ? ' 多来源页面不会被单源增量抽取覆盖。' : ''}</div>
    <div className={w.toolbar}>
      <Button disabled={!base || readOnly || saving || reloading || dirty || !draftRefs.length} onClick={() => base?.locked ? setUnlocking(true) : void setLocked(true)}>{base?.locked === false ? '锁定页面' : '允许自动更新'}</Button>
      <Button disabled={!base || saving || reloading} onClick={() => void reload()}>重新载入原版本</Button>
      <Button danger disabled={!base || readOnly || saving || reloading} onClick={async () => { if (base && await confirmDiscard()) (onDeleteRequested ?? setDeleteTarget)({ kind: 'page', kbId: base.kbId, pageId: base.pageId }); }}>删除页面</Button>
    </div>
    <Modal open={confirmationVisible && confirming} title="放弃未保存修改？" onCancel={() => settleDiscard(false)} onOk={() => settleDiscard(true)} okText="放弃修改" cancelText="继续编辑"><p>未保存的标题、正文和来源关联将被丢弃。</p></Modal>
    <Modal open={visible && unlocking} title="允许后续抽取更新" onCancel={() => setUnlocking(false)} onOk={() => void setLocked(false)} okText="允许后续抽取更新" cancelText="保持锁定" confirmLoading={saving}><p>解除人工锁定不会立即调用模型。{draftRefs.length > 1 ? '此页关联多份资料，仍不会被单源增量抽取覆盖。' : '下次显式抽取可能更新此页面。'}</p></Modal>
    <Modal open={visible && !!snapshot} title={`来源快照 · r${snapshot?.ref.revision ?? ''}`} onCancel={() => { sourceSequence.current++; setSnapshot(undefined); }} footer={<Button onClick={() => { sourceSequence.current++; setSnapshot(undefined); }}>关闭快照</Button>}>
      {snapshot?.source ? <p>{snapshot.source.name} · {snapshot.source.kind}{snapshot.source.lifecycle === 'deleted' ? ' · 来源已删除' : ''}</p> : null}
      {snapshot?.error ? <Alert type="error" title={snapshot.error} /> : snapshot?.content !== undefined ? <div className={w.document}><LazyMarkdown prose={false}>{snapshot.content}</LazyMarkdown></div> : <p>正在读取快照…</p>}
    </Modal>
    <WikiDeleteDialog target={visible ? deleteTarget : undefined} onClose={() => setDeleteTarget(undefined)} onDeleted={onClose} />
  </section>;
});
