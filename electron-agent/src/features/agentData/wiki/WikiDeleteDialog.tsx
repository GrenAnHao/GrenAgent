import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal } from 'antd';
import { agentDataApi } from '../../../lib/agentData';
import type { WikiDeletePreview, WikiDeleteResult, WikiTarget } from '../../../../electron/agentData/wikiContracts';

interface Props { target?: WikiTarget; onClose(): void; onDeleted(target: WikiTarget): void; onWaiting?(target: WikiTarget): void }

export function wikiTargetKey(target?: WikiTarget): string {
  if (!target) return '';
  const id = target.kind === 'source' ? target.sourceId : target.kind === 'page' ? target.pageId : '';
  return JSON.stringify([target.kind, target.kbId, id]);
}

export function WikiDeleteDialog({ target, onClose, onDeleted, onWaiting }: Props) {
  const [preview, setPreview] = useState<WikiDeletePreview>();
  const [error, setError] = useState<string>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<Extract<WikiDeleteResult, { state: 'waiting' }>>();
  const [cancelRequested, setCancelRequested] = useState(false);
  const sequence = useRef(0);
  const key = wikiTargetKey(target);
  const currentTarget = useRef(key);
  currentTarget.current = key;
  const isCurrent = (request: number) => request === sequence.current && currentTarget.current === key && !!key;
  useEffect(() => {
    const requestId = ++sequence.current;
    setPreview(undefined); setError(undefined); setName(''); setWaiting(undefined); setCancelRequested(false); setBusy(false);
    if (!target) return;
    let request: Promise<WikiDeletePreview>;
    if (target.kind === 'library') request = agentDataApi.wiki.libraries.previewDelete(target.kbId);
    else if (target.kind === 'source') request = agentDataApi.wiki.sources.previewDelete(target.kbId, target.sourceId);
    else request = agentDataApi.wiki.pages.previewDelete(target.kbId, target.pageId);
    void request.then((result) => { if (isCurrent(requestId)) setPreview(result); }).catch((cause) => { if (isCurrent(requestId)) setError(String(cause)); });
    return () => { sequence.current++; };
  }, [key]);

  const remove = async (cancelActive: boolean) => {
    if (!preview || busy || wikiTargetKey(preview.target) !== key || preview.target.kind === 'library' && name !== preview.name) return;
    const stable = preview.target;
    const request = sequence.current;
    setBusy(true); setError(undefined);
    try {
      let result: WikiDeleteResult;
      if (stable.kind === 'library') result = await agentDataApi.wiki.libraries.remove(stable.kbId, cancelActive);
      else if (stable.kind === 'source') result = await agentDataApi.wiki.sources.remove(stable.kbId, stable.sourceId, cancelActive);
      else result = await agentDataApi.wiki.pages.remove(stable.kbId, stable.pageId, cancelActive);
      if (!isCurrent(request)) return;
      if (result.state === 'deleted') { onDeleted(stable); onClose(); }
      else { setWaiting(result); setCancelRequested(cancelActive); onWaiting?.(stable); }
    } catch (cause) { if (isCurrent(request)) setError(String(cause)); }
    finally { if (isCurrent(request)) setBusy(false); }
  };

  return <Modal open={!!target} title="确认删除内容" closable={!busy} keyboard={!busy} onCancel={() => { if (!busy) onClose(); }} footer={<>
    <Button disabled={busy} onClick={onClose}>关闭</Button>
    {waiting?.tasks.some((task) => task.active && task.canCancel) ? <Button disabled={busy} onClick={() => void remove(true)}>请求取消任务</Button> : null}
    <Button danger type="primary" loading={busy} disabled={!preview || preview.target.kind === 'library' && name !== preview.name} onClick={() => void remove(false)}>{waiting ? '重试删除' : '确认删除'}</Button>
  </>}>
    {error ? <Alert type="error" title={error} showIcon /> : null}
    {!preview && !error ? <p>正在读取删除影响…</p> : null}
    {preview ? <>
      <p><strong>{preview.name}</strong> · {preview.sources} 份资料 · {preview.pages} 个页面</p>
      <p>关联项目：{preview.bindings.join('、') || '无'}</p>
      {preview.target.kind === 'library' ? <>
        <p>仅删除本知识库内容，不删除项目原文件、审计记录或任务历史。</p>
        <label>输入知识库名称确认<Input aria-label="输入知识库名称确认" value={name} onChange={(event) => setName(event.target.value)} /></label>
      </> : <p>{preview.target.kind === 'source' ? '引用页面与必要的来源快照会保留，并标记来源已删除。' : '该页面不会被后续普通抽取自动恢复；需要从来源显式重新生成。'}</p>}
    </> : null}
    {waiting ? <Alert type="warning" title={cancelRequested ? '正在取消，等待任务结束后重试删除' : '等待任务结束后重试删除'} description={<ul>{waiting.tasks.map((task) => <li key={`${task.taskSource}:${task.taskId}`}>{task.taskId} · {task.canCancel ? '可请求取消' : '系统任务不可取消，请等待'}</li>)}</ul>} /> : null}
  </Modal>;
}
