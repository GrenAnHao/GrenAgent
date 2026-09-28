import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Alert, Button, Input, Modal } from 'antd';
import { agentDataApi } from '../../../lib/agentData';
import { LazyMarkdown } from '../../chat/LazyMarkdown';
import { wikiStyles as w } from './wikiStyles';
import { workbenchStyles as s } from '../workbench/workbenchStyles';

interface Props {
  wikiId: string;
  pageId: string;
  title: string;
  content?: string;
  readOnly: boolean;
  visible?: boolean;
  confirmationVisible?: boolean;
  onSaved(): void;
  onClose(): void;
}
export interface WikiPageEditorHandle { confirmDiscard(): Promise<boolean>; isDirty(): boolean }

export const WikiPageEditor = forwardRef<WikiPageEditorHandle, Props>(function WikiPageEditor({
  wikiId, pageId, title, content = '', readOnly, visible = true, confirmationVisible = visible, onSaved, onClose,
}, ref) {
  const [draftTitle, setTitle] = useState(title);
  const [draftContent, setContent] = useState(content);
  const [baseTitle, setBaseTitle] = useState(title);
  const [baseContent, setBaseContent] = useState(content);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const discardResolver = useRef<((discard: boolean) => void) | undefined>(undefined);
  const dirty = draftTitle !== baseTitle || draftContent !== baseContent;

  useEffect(() => {
    if (!dirty) {
      setTitle(title);
      setContent(content);
      setBaseTitle(title);
      setBaseContent(content);
    }
  }, [title, content]);

  useEffect(() => {
    if (!confirmationVisible) { setConfirming(false); discardResolver.current?.(false); discardResolver.current = undefined; }
  }, [confirmationVisible]);

  const confirmDiscard = () => {
    if (saving) { setError('正在保存，请等待保存完成后再离开。'); return Promise.resolve(false); }
    if (!dirty) return Promise.resolve(true);
    discardResolver.current?.(false);
    setConfirming(true);
    return new Promise<boolean>((resolve) => { discardResolver.current = resolve; });
  };
  useImperativeHandle(ref, () => ({ confirmDiscard, isDirty: () => dirty }));
  const settleDiscard = (discard: boolean) => { setConfirming(false); discardResolver.current?.(discard); discardResolver.current = undefined; };

  const save = async () => {
    if (readOnly || saving || !visible || !draftTitle.trim()) return;
    setSaving(true); setError(undefined);
    try {
      const body = draftContent.startsWith('---\n')
        ? draftContent.replace(/^---\n([\s\S]*?)\n---\n?/, (block) => {
          if (/^title:/m.test(block)) return block.replace(/^title:.*$/m, `title: ${draftTitle.trim()}`);
          return block.replace('---\n', `---\ntitle: ${draftTitle.trim()}\n`);
        })
        : `---\ntitle: ${draftTitle.trim()}\n---\n${draftContent}`;
      await agentDataApi.wiki.pageWrite(wikiId, pageId, body);
      setBaseTitle(draftTitle);
      setBaseContent(draftContent);
      onSaved();
    } catch (cause) { setError(String(cause)); }
    finally { setSaving(false); }
  };

  return <div className={w.editor}>
    <div className={w.toolbar}>
      <span className={s.spacer} />
      <Button aria-label="关闭页面详情" size="small" autoInsertSpace={false} onClick={() => void confirmDiscard().then((ok) => { if (ok) onClose(); })}>取消</Button>
      <Button type="primary" disabled={readOnly || !dirty} loading={saving} onClick={() => void save()}>保存页面</Button>
    </div>
    {error ? <Alert type="error" title={error} showIcon /> : null}
    <label className={w.field}>标题<Input aria-label="页面标题" value={draftTitle} disabled={readOnly} onChange={(event) => setTitle(event.target.value)} /></label>
    <label className={w.field}>Markdown 正文<Input.TextArea aria-label="Markdown 正文" rows={14} value={draftContent} disabled={readOnly} onChange={(event) => setContent(event.target.value)} /></label>
    <details><summary>预览</summary><div className={`${w.document} ${w.preview}`}><LazyMarkdown prose={false}>{draftContent}</LazyMarkdown></div></details>
    <Modal open={confirming && confirmationVisible} title="放弃未保存修改？" onCancel={() => settleDiscard(false)} onOk={() => settleDiscard(true)} okText="放弃修改" cancelText="继续编辑" />
  </div>;
});
