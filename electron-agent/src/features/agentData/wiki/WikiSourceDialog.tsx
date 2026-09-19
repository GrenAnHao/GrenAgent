import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Select, Tabs } from 'antd';
import { agentDataApi } from '../../../lib/agentData';
import type { WikiImportPreview, WikiSource } from '../../../../electron/agentData/wikiContracts';
import { LazyMarkdown } from '../../chat/LazyMarkdown';
import { wikiStyles as w } from './wikiStyles';

interface Props { open: boolean; visible?: boolean; kbId: string; bindings: string[]; source?: WikiSource; onClose(): void; onSaved(): void }
interface UploadResult { name: string; state: 'saving' | 'saved' | 'failed'; error?: string }

export function WikiSourceDialog({ open, visible = true, kbId, bindings, source, onClose, onSaved }: Props) {
  const [tab, setTab] = useState('upload');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [base, setBase] = useState(source);
  const [project, setProject] = useState(bindings[0] ?? '');
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<WikiImportPreview>();
  const [uploads, setUploads] = useState<UploadResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [readReady, setReadReady] = useState(!source);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  const currentSession = useRef({ open, kbId, sourceId: source?.sourceId });
  currentSession.current = { open, kbId, sourceId: source?.sourceId };
  const isCurrent = (request: number) => request === sequence.current && currentSession.current.open && currentSession.current.kbId === kbId && currentSession.current.sourceId === source?.sourceId;
  useEffect(() => {
    sequence.current++;
    if (!open) return;
    setTab(source ? 'manual' : 'upload'); setBase(source); setName(source?.name ?? ''); setContent('');
    setProject(bindings[0] ?? ''); setPath(''); setPreview(undefined); setUploads([]); setError(undefined); setSaved(false);
    setBusy(false); setReading(false); setReadReady(!source);
    return () => { sequence.current++; };
  }, [open, kbId, source?.sourceId]);
  useEffect(() => {
    if (!open || !visible || !source || readReady) return;
    let cancelled = false;
    const request = sequence.current;
    setReading(true);
    void agentDataApi.wiki.sources.read(kbId, source.sourceId)
      .then((result) => { if (!cancelled && isCurrent(request)) { setBase(result.source); setContent(result.content); setReading(false); setReadReady(true); } })
      .catch((cause) => { if (!cancelled && isCurrent(request)) { setError(String(cause)); setReading(false); } });
    return () => { cancelled = true; };
  }, [open, visible, kbId, source?.sourceId, readReady]);

  const upload = async (files: File[]) => {
    if (busy || source) return;
    setBusy(true); setError(undefined);
    const request = sequence.current;
    const results: UploadResult[] = files.map((file) => ({ name: file.name, state: 'saving' }));
    setUploads([...results]);
    for (let index = 0; index < files.length; index++) {
      if (!isCurrent(request)) break;
      try {
        if (!/\.(md|txt)$/i.test(files[index].name)) throw new Error('不支持此格式，仅支持 .md 和 .txt');
        const text = await files[index].text();
        if (!isCurrent(request)) return;
        await agentDataApi.wiki.sources.create(kbId, { kind: 'upload', name: files[index].name, content: text });
        if (!isCurrent(request)) return;
        results[index] = { name: files[index].name, state: 'saved' };
        onSaved();
      } catch (cause) { results[index] = { name: files[index].name, state: 'failed', error: String(cause) }; }
      if (isCurrent(request)) setUploads([...results]);
    }
    if (isCurrent(request)) setBusy(false);
  };
  const saveText = async () => {
    if (busy || reading || !readReady || saved || !name.trim() || base && base.lifecycle !== 'active') return;
    if (base && (base.kbId !== kbId || base.sourceId !== source?.sourceId)) return;
    const request = sequence.current;
    const target = base;
    setBusy(true); setError(undefined);
    try {
      const updated = target
        ? await agentDataApi.wiki.sources.update(target.kbId, target.sourceId, content, { revision: target.revision, contentHash: target.contentHash })
        : await agentDataApi.wiki.sources.create(kbId, { kind: 'manual', name: name.trim(), content });
      if (!isCurrent(request)) return;
      if (target) setBase(updated);
      setSaved(true); onSaved();
    } catch (cause) { if (isCurrent(request)) setError(String(cause)); }
    finally { if (isCurrent(request)) setBusy(false); }
  };
  const previewImport = async () => {
    if (!project || !path.trim() || busy) return;
    const request = sequence.current;
    setBusy(true); setError(undefined); setPreview(undefined);
    try { const result = await agentDataApi.wiki.sources.previewImport(kbId, project, path.trim()); if (isCurrent(request)) setPreview(result); }
    catch (cause) { if (isCurrent(request)) setError(String(cause)); }
    finally { if (isCurrent(request)) setBusy(false); }
  };
  const importProject = async () => {
    if (!preview || busy) return;
    const request = sequence.current;
    setBusy(true); setError(undefined);
    try {
      await agentDataApi.wiki.sources.create(kbId, { kind: 'project', projectWorkspace: preview.projectWorkspace, relativePath: preview.relativePath, expectedContentHash: preview.contentHash });
      if (!isCurrent(request)) return;
      setSaved(true); setPreview(undefined); onSaved();
    } catch (cause) { if (isCurrent(request)) setError(String(cause)); }
    finally { if (isCurrent(request)) setBusy(false); }
  };

  return <Modal open={open && visible} width={720} title={source ? '更新这份资料' : '添加原始资料'} closable={!busy} keyboard={!busy} onCancel={() => { if (!busy) onClose(); }} footer={<Button disabled={busy} onClick={onClose}>稍后抽取</Button>}>
    <p className={w.muted}>保存资料不会调用模型；回到知识库后可显式开始抽取。</p>
    {error ? <Alert type="error" title={error} showIcon /> : null}
    {saved ? <Alert type="success" title={source ? '资料已更新' : '资料已添加'} /> : null}
    <Tabs id="wiki-source" activeKey={tab} onChange={setTab} items={[
      ...(!source ? [{ key: 'upload', label: '上传文件', children: <>
        <label className={w.field}>上传 Markdown 或文本<input type="file" multiple accept=".md,.txt" aria-label="上传资料" disabled={busy} onChange={(event) => { void upload(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></label>
        <ul aria-live="polite">{uploads.map((result, index) => <li key={index}>{result.name} · {result.state === 'saved' ? '资料已添加' : result.state === 'saving' ? '正在添加' : result.error}</li>)}</ul>
      </> }] : []),
      { key: 'manual', label: '手动录入', children: <>
        <label className={w.field}>资料名称<Input aria-label="资料名称" value={name} disabled={!!source || busy} onChange={(event) => { setName(event.target.value); setSaved(false); }} /></label>
        <label className={w.field}>Markdown 原文<Input.TextArea aria-label="资料 Markdown" rows={9} value={content} disabled={reading || busy || !!base && base.lifecycle !== 'active'} onChange={(event) => { setContent(event.target.value); setSaved(false); }} /></label>
        <details><summary>预览资料</summary><div className={`${w.document} ${w.preview}`}><LazyMarkdown prose={false}>{content}</LazyMarkdown></div></details>
        <Button type="primary" loading={busy} disabled={reading || !readReady || saved || !name.trim() || !!base && base.lifecycle !== 'active'} onClick={() => void saveText()}>{source ? '更新这份资料' : '添加资料'}</Button>
      </> },
      ...(!source ? [{ key: 'project', label: '从项目导入', children: <>
        {!bindings.length ? <Alert type="info" title="请先在知识库属性中关联项目" /> : null}
        <label className={w.field}>关联项目<Select aria-label="导入项目" disabled={busy} value={project} style={{ width: '100%' }} onChange={(value) => { setProject(value); setPreview(undefined); setSaved(false); }} options={bindings.map((binding) => ({ value: binding, label: binding }))} /></label>
        <label className={w.field}>项目相对路径<Input aria-label="项目相对路径" placeholder="docs/README.md" value={path} disabled={busy} onChange={(event) => { setPath(event.target.value); setPreview(undefined); setSaved(false); }} /></label>
        <Button disabled={!project || !path.trim() || busy} onClick={() => void previewImport()}>预览导入</Button>
        {preview ? <div className={w.preview}><p>{preview.projectWorkspace}</p><p>{preview.relativePath} · {preview.bytes} 字节</p><Button type="primary" loading={busy} onClick={() => void importProject()}>确认导入</Button></div> : null}
      </> }] : []),
    ]} />
  </Modal>;
}
