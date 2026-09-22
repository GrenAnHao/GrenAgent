import { useEffect, useRef, useState } from 'react';
import { Alert, Form, Input, Modal } from 'antd';
import { agentDataApi, type WikiAssetDetail } from '../../../lib/agentData';

interface Props { open: boolean; visible?: boolean; library?: WikiAssetDetail; onClose(): void; onSaved(library: WikiAssetDetail): void }

export function WikiLibraryDialog({ open, visible = true, library, onClose, onSaved }: Props) {
  const [form] = Form.useForm<{ name: string; summary: string }>();
  const original = useRef(library);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  const currentSession = useRef({ open, wikiId: library?.wikiId });
  currentSession.current = { open, wikiId: library?.wikiId };
  const isCurrent = (request: number) => request === sequence.current && currentSession.current.open && currentSession.current.wikiId === library?.wikiId;
  useEffect(() => {
    sequence.current++;
    if (!open) return;
    original.current = library;
    setError(undefined); setSaving(false);
    form.setFieldsValue({ name: library?.name ?? '', summary: library?.summary ?? '' });
    return () => { sequence.current++; };
  }, [open, library?.wikiId, form]);

  const save = async () => {
    if (saving) return;
    const target = original.current;
    const request = sequence.current;
    setSaving(true);
    try {
      let values: { name: string; summary: string };
      try { values = await form.validateFields(); } catch { return; }
      if (!isCurrent(request)) return;
      const name = values.name.trim();
      const summary = (values.summary ?? '').trim();
      const saved = target
        ? await agentDataApi.wiki.update(target.wikiId, { name, summary: summary || null })
        : await agentDataApi.wiki.create({ name });
      if (!isCurrent(request)) return;
      if (!target && summary) {
        const updated = await agentDataApi.wiki.update(saved.wikiId, { summary });
        if (isCurrent(request)) onSaved(updated);
        return;
      }
      if (isCurrent(request)) onSaved(saved);
    } catch (cause) { if (isCurrent(request)) setError(String(cause)); }
    finally { if (isCurrent(request)) setSaving(false); }
  };

  return <Modal open={open && visible} width={520} title={library ? '知识库属性' : '新建知识库'} closable={!saving} keyboard={!saving} onCancel={() => { if (!saving) onClose(); }} onOk={() => void save()} okText="保存知识库" cancelText="取消" confirmLoading={saving} cancelButtonProps={{ disabled: saving }} okButtonProps={{ style: { height: 36 } }}>
    {error ? <Alert type="error" title={error} showIcon /> : null}
    <Form form={form} layout="vertical" disabled={saving} initialValues={{ name: '', summary: '' }}>
      <Form.Item label="名称" name="name" rules={[{ validator: (_, value: string = '') => [...value.trim()].length >= 1 && [...value.trim()].length <= 80 ? Promise.resolve() : Promise.reject(new Error('名称需为 1–80 个字符')) }]}>
        <Input aria-label="知识库名称" autoFocus />
      </Form.Item>
      <Form.Item label="用途" name="summary" rules={[{ validator: (_, value: string = '') => [...value.trim()].length <= 500 ? Promise.resolve() : Promise.reject(new Error('用途最多 500 个字符')) }]}>
        <Input.TextArea aria-label="知识库用途" rows={3} />
      </Form.Item>
    </Form>
  </Modal>;
}
