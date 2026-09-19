import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Alert, Button, Input, Select, Typography } from 'antd';
import { agentDataApi, type ManagedMemoryRecord, type MemoryDraft, type MemoryLevel } from '../../lib/agentData';
import { memoryLevelLabels } from './memoryPresentation';
import { memoryStyles as m } from './memoryStyles';

interface Props { userId: string; record?: ManagedMemoryRecord; projects: Array<{ cwd: string; name: string }>; unavailable?: boolean; onUnavailable?(): void; onSaved(record: ManagedMemoryRecord): void; onCancel(): void }
export interface MemoryEditorHandle { confirmLeave(): boolean }
interface DraftState { targetKey: string; userId: string; base?: ManagedMemoryRecord; content: string; level: MemoryLevel; owner: string; source: string }
const ownerValue = (record?: ManagedMemoryRecord) => record ? record.scope === 'global' ? 'global' : `project:${record.sourceProjectId ?? ''}` : '';
const newDraft = (userId: string, targetKey: string, base?: ManagedMemoryRecord): DraftState => ({ userId, targetKey, base, content: base?.content ?? '', level: base?.level ?? 1, owner: ownerValue(base), source: base?.source ?? '' });
function hasErrorCode(cause: unknown, code: string) {
  return (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === code) || String(cause).includes(code);
}

export const MemoryEditor = forwardRef<MemoryEditorHandle, Props>(function MemoryEditor({ userId, record, projects, unavailable = false, onUnavailable, onSaved, onCancel }, ref) {
  const targetKey = JSON.stringify([userId, record?.id]);
  const [draft, setDraft] = useState(() => newDraft(userId, targetKey, record));
  const [busy, setBusy] = useState<'save' | 'reload'>();
  const [error, setError] = useState<string>();
  const [deleted, setDeleted] = useState(false);
  const runtime = useRef({ targetKey, unavailable, epoch: 0, busy: false, mounted: true });
  if (runtime.current.targetKey !== targetKey || runtime.current.unavailable !== unavailable) {
    runtime.current.targetKey = targetKey;
    runtime.current.unavailable = unavailable;
    runtime.current.epoch++;
    runtime.current.busy = false;
  }
  const dirty = draft.content !== (draft.base?.content ?? '') || draft.level !== (draft.base?.level ?? 1) || draft.owner !== ownerValue(draft.base) || draft.source !== (draft.base?.source ?? '');
  const targetMismatch = draft.targetKey !== targetKey;
  const backgroundUpdated = !targetMismatch && !!record && !!draft.base && record.revision > draft.base.revision;
  const apply = (next: ManagedMemoryRecord | undefined, nextUser = userId) => {
    setDraft(newDraft(nextUser, targetKey, next));
    setError(undefined); setDeleted(false); setBusy(undefined); runtime.current.busy = false;
  };
  useEffect(() => {
    if (!dirty && !runtime.current.busy) apply(record);
  }, [record, userId]);
  useEffect(() => { setBusy(undefined); setError(undefined); setDeleted(false); }, [targetKey]);
  useEffect(() => { if (unavailable) setBusy(undefined); }, [unavailable]);
  useEffect(() => {
    runtime.current.mounted = true;
    return () => { runtime.current.mounted = false; runtime.current.epoch++; };
  }, []);
  const validOwner = draft.owner === 'global' || (draft.owner.startsWith('project:') && draft.owner.length > 'project:'.length);
  const canSave = !!draft.content.trim() && validOwner && !busy && !targetMismatch && !deleted && !unavailable;
  const confirmLeave = () => {
    if (runtime.current.busy) return false;
    return !dirty || window.confirm('放弃未保存的记忆修改？');
  };
  useImperativeHandle(ref, () => ({ confirmLeave }));
  const close = () => { if (confirmLeave()) onCancel(); };
  const save = async () => {
    if (!canSave || runtime.current.busy) return;
    const state = runtime.current;
    const epoch = ++state.epoch;
    const captured = draft;
    const isCurrent = () => state.mounted && state.epoch === epoch && state.targetKey === targetKey;
    state.busy = true; setBusy('save'); setError(undefined);
    const input: MemoryDraft = {
      content: captured.content.trim(), level: captured.base?.level === 0 ? 0 : captured.level,
      owner: captured.owner === 'global' ? { scope: 'global' } : { scope: 'project', projectId: captured.owner.slice('project:'.length) },
      ...(captured.source ? { source: captured.source } : {}),
    };
    try {
      const saved = captured.base
        ? await agentDataApi.memory.update({ userId: captured.userId, id: captured.base.id, expectedRevision: captured.base.revision, draft: input })
        : await agentDataApi.memory.create({ userId: captured.userId, draft: input });
      if (isCurrent()) { apply(saved, captured.userId); onSaved(saved); }
    } catch (cause) {
      if (!isCurrent()) return;
      if (hasErrorCode(cause, 'NOT_FOUND')) { setDeleted(true); setError('记录已被外部删除；当前草稿仍保留，可复制正文。'); onUnavailable?.(); }
      else setError(hasErrorCode(cause, 'VERSION_CONFLICT') ? '记录已被修改，你的草稿已保留' : String(cause));
    } finally { if (isCurrent()) { state.busy = false; setBusy(undefined); } }
  };
  const reload = async () => {
    if (runtime.current.busy) return;
    const target = targetMismatch ? record : draft.base;
    const targetUser = targetMismatch ? userId : draft.userId;
    const state = runtime.current;
    const beforeConfirmation = state.epoch;
    if (dirty && !window.confirm('放弃未保存修改并重新载入？')) return;
    if (beforeConfirmation !== state.epoch || !state.mounted) return;
    if (!target) { apply(undefined, targetUser); return; }
    const epoch = ++state.epoch;
    const isCurrent = () => state.mounted && state.epoch === epoch && state.targetKey === targetKey;
    state.busy = true; setBusy('reload'); setError(undefined);
    try {
      const next = await agentDataApi.memory.read({ userId: targetUser, id: target.id });
      if (isCurrent()) {
        if (next) apply(next, targetUser);
        else { setDeleted(true); setError('记录已被外部删除；当前草稿仍保留，可复制正文。'); onUnavailable?.(); }
      }
    } catch (cause) {
      if (isCurrent()) {
        if (hasErrorCode(cause, 'NOT_FOUND')) { setDeleted(true); setError('记录已被外部删除；当前草稿仍保留，可复制正文。'); onUnavailable?.(); }
        else setError(String(cause));
      }
    } finally { if (isCurrent()) { state.busy = false; setBusy(undefined); } }
  };
  const change = <K extends 'content' | 'level' | 'owner' | 'source'>(key: K, value: DraftState[K]) => {
    if (!runtime.current.busy) setDraft((previous) => ({ ...previous, [key]: value }));
  };
  const unavailableProject = draft.owner.startsWith('project:') && !projects.some((project) => `project:${project.cwd}` === draft.owner);
  return <section className={m.document} aria-label="记忆编辑器" onKeyDown={(event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) void save(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <div className={m.toolbar}>
      <Button disabled={!!busy} onClick={close}>关闭编辑</Button>
      <Button type="primary" disabled={!canSave} onClick={() => void save()}>保存记忆</Button>
      {draft.base || targetMismatch ? <Button disabled={!!busy} onClick={() => void reload()}>{targetMismatch ? '载入当前记录' : '重新载入'}</Button> : null}
      {dirty ? <Typography.Text role="status">未保存修改</Typography.Text> : null}
      {busy ? <Typography.Text role="status">{busy === 'save' ? '正在保存…' : '正在重新载入…'}</Typography.Text> : null}
    </div>
    {error ? <Alert type="error" showIcon title={error} /> : null}
    {unavailable && !deleted ? <Alert type="error" showIcon title="原记录不可写；草稿内容仍可复制。" /> : null}
    {targetMismatch ? <Typography.Text role="status" type="secondary">当前用户或记录已变化，原草稿仍保留；载入当前记录前不会写入其它目标。</Typography.Text> : backgroundUpdated && dirty ? <Typography.Text role="status" type="secondary">数据已更新，你的草稿未改变。保存时会检查原版本。</Typography.Text> : null}
    <label className={m.field}>记忆正文<Input.TextArea aria-label="记忆正文" rows={12} value={draft.content} readOnly={!!busy} onChange={(event) => change('content', event.target.value)} /></label>
    <label className={m.field}>记忆层级<Select aria-label="编辑记忆层级" value={draft.level} disabled={!!busy || draft.base?.level === 0} onChange={(value) => change('level', Number(value) as MemoryLevel)} options={[
      ...(draft.base?.level === 0 ? [{ value: 0, label: memoryLevelLabels[0] }] : []),
      ...[1, 2, 3].map((value) => ({ value, label: memoryLevelLabels[value as 1 | 2 | 3] })),
    ]} /></label>
    <label className={m.field}>归属范围<Select aria-label="归属范围" value={draft.owner || undefined} placeholder="请选择归属范围" disabled={!!busy} onChange={(value) => change('owner', value)} options={[
      { value: 'global', label: '全局' },
      ...(unavailableProject ? [{ value: draft.owner, label: `原项目已不可用 · ${draft.owner.slice('project:'.length)}` }] : []),
      ...projects.map((project) => ({ value: `project:${project.cwd}`, label: project.name })),
    ]} /></label>
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{draft.owner === 'global' ? '全局记忆可在本用户所有项目中召回。' : draft.owner ? '项目记忆仅在所选项目中召回，不会改变原来源会话。' : '保存前请选择全局或一个真实项目。'}</Typography.Text>
    <label className={m.field}>来源说明（可选）<Input aria-label="来源说明" value={draft.source} readOnly={!!busy} onChange={(event) => change('source', event.target.value)} /></label>
  </section>;
});
