import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Tabs } from 'antd';
import { agentDataApi } from '../../../lib/agentData';
import { LazyMarkdown } from '../../chat/LazyMarkdown';
import { wikiStyles as w } from './wikiStyles';

interface Props {
  open: boolean;
  visible?: boolean;
  wikiId: string;
  disabled?: boolean;
  onClose(): void;
  onSaved(): void;
}
interface UploadResult { name: string; state: 'saving' | 'saved' | 'failed'; error?: string }

export function WikiSourceDialog({ open, visible = true, wikiId, disabled = false, onClose, onSaved }: Props) {
  const [tab, setTab] = useState('upload');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [uploads, setUploads] = useState<UploadResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  const currentSession = useRef({ open, wikiId });
  currentSession.current = { open, wikiId };
  const isCurrent = (request: number) => request === sequence.current && currentSession.current.open && currentSession.current.wikiId === wikiId;

  useEffect(() => {
    sequence.current++;
    if (!open) return;
    setTab('upload'); setName(''); setContent(''); setUploads([]); setError(undefined); setSaved(false); setBusy(false);
    return () => { sequence.current++; };
  }, [open, wikiId]);

  const upload = async (files: File[]) => {
    if (busy || disabled) return;
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
        await agentDataApi.wiki.rawWrite(wikiId, files[index].name, text);
        if (!isCurrent(request)) return;
        results[index] = { name: files[index].name, state: 'saved' };
        onSaved();
      } catch (cause) { results[index] = { name: files[index].name, state: 'failed', error: String(cause) }; }
      if (isCurrent(request)) setUploads([...results]);
    }
    if (isCurrent(request)) setBusy(false);
  };

  const saveText = async () => {
    if (busy || disabled || saved || !name.trim()) return;
    const filename = /\.(md|txt)$/i.test(name.trim()) ? name.trim() : `${name.trim()}.md`;
    const request = sequence.current;
    setBusy(true); setError(undefined);
    try {
      await agentDataApi.wiki.rawWrite(wikiId, filename, content);
      if (!isCurrent(request)) return;
      setSaved(true); onSaved();
    } catch (cause) { if (isCurrent(request)) setError(String(cause)); }
    finally { if (isCurrent(request)) setBusy(false); }
  };

  return <Modal open={open && visible} width={720} title="上传原文" closable={!busy} keyboard={!busy} onCancel={() => { if (!busy) onClose(); }} footer={<Button disabled={busy} onClick={onClose}>稍后抽取</Button>}>
    <p className={w.muted}>保存原文不会调用模型；回到知识库后可显式开始抽取。</p>
    {error ? <Alert type="error" title={error} showIcon /> : null}
    {saved ? <Alert type="success" title="资料已添加" /> : null}
    <Tabs id="wiki-source" activeKey={tab} onChange={setTab} items={[
      { key: 'upload', label: '上传文件', children: <>
        <label className={w.field}>上传 Markdown 或文本<input type="file" multiple accept=".md,.txt" aria-label="上传资料" disabled={busy || disabled} onChange={(event) => { void upload(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></label>
        <ul aria-live="polite">{uploads.map((result, index) => <li key={index}>{result.name} · {result.state === 'saved' ? '资料已添加' : result.state === 'saving' ? '正在添加' : result.error}</li>)}</ul>
      </> },
      { key: 'manual', label: '手动录入', children: <>
        <label className={w.field}>资料名称<Input aria-label="资料名称" value={name} disabled={busy || disabled} onChange={(event) => { setName(event.target.value); setSaved(false); }} /></label>
        <label className={w.field}>Markdown 原文<Input.TextArea aria-label="资料 Markdown" rows={9} value={content} disabled={busy || disabled} onChange={(event) => { setContent(event.target.value); setSaved(false); }} /></label>
        <details><summary>预览资料</summary><div className={`${w.document} ${w.preview}`}><LazyMarkdown prose={false}>{content}</LazyMarkdown></div></details>
        <Button type="primary" loading={busy} disabled={disabled || saved || !name.trim()} onClick={() => void saveText()}>添加资料</Button>
      </> },
    ]} />
  </Modal>;
}
