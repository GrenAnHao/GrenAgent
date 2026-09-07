import { useEffect, useRef, useState } from 'react';
import { Alert, Form, Input, Modal, Select } from 'antd';
import { agentDataApi } from '../../../lib/agentData';
import type { WikiLibraryInput, WikiLibraryView } from '../../../../electron/agentData/wikiContracts';
import { useProjectOptions } from '../useProjectOptions';

interface Props { open: boolean; visible?: boolean; library?: WikiLibraryView; onClose(): void; onSaved(library: WikiLibraryView): void }

export function WikiLibraryDialog({ open, visible = true, library, onClose, onSaved }: Props) {
  const projects = useProjectOptions();
  const [form] = Form.useForm<WikiLibraryInput>();
  const original = useRef(library);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  const currentSession = useRef({ open, kbId: library?.kbId });
  currentSession.current = { open, kbId: library?.kbId };
  const isCurrent = (request: number) => request === sequence.current && currentSession.current.open && currentSession.current.kbId === library?.kbId;
  useEffect(() => {
    sequence.current++;
    if (!open) return;
    original.current = library;
    setError(undefined); setSaving(false);
    form.setFieldsValue({ name: library?.name ?? '', description: library?.description ?? '', bindings: library?.bindings ?? [] });
    return () => { sequence.current++; };
  }, [open, library?.kbId, form]);

  const save = async () => {
    if (saving || original.current?.lifecycle && original.current.lifecycle !== 'active') return;
    const target = original.current;
    const request = sequence.current;
    setSaving(true);
    try {
      let values: WikiLibraryInput;
      try { values = await form.validateFields(); } catch { return; }
      if (!isCurrent(request)) return;
      const input = { name: values.name.trim(), description: (values.description ?? '').trim(), bindings: values.bindings ?? [] };
      const saved = target
        ? await agentDataApi.wiki.libraries.update(target.kbId, input, target.revision)
        : await agentDataApi.wiki.libraries.create(input);
      if (isCurrent(request)) onSaved(saved);
    } catch (cause) { if (isCurrent(request)) setError(String(cause)); }
    finally { if (isCurrent(request)) setSaving(false); }
  };

  return <Modal open={open && visible} width={520} title={library ? '知识库属性' : '新建知识库'} closable={!saving} keyboard={!saving} onCancel={() => { if (!saving) onClose(); }} onOk={() => void save()} okText="保存知识库" cancelText="取消" confirmLoading={saving} cancelButtonProps={{ disabled: saving }} okButtonProps={{ style: { height: 36 }, disabled: library?.lifecycle !== undefined && library.lifecycle !== 'active' }}>
    {error ? <Alert type="error" title={error} showIcon /> : null}
    <Form form={form} layout="vertical" disabled={saving} initialValues={{ name: '', description: '', bindings: [] }}>
      <Form.Item label="名称" name="name" rules={[{ validator: (_, value: string = '') => [...value.trim()].length >= 1 && [...value.trim()].length <= 80 ? Promise.resolve() : Promise.reject(new Error('名称需为 1–80 个字符')) }]}>
        <Input aria-label="知识库名称" autoFocus />
      </Form.Item>
      <Form.Item label="用途" name="description" rules={[{ validator: (_, value: string = '') => [...value.trim()].length <= 500 ? Promise.resolve() : Promise.reject(new Error('用途最多 500 个字符')) }]}>
        <Input.TextArea aria-label="知识库用途" rows={3} />
      </Form.Item>
      <Form.Item label="关联项目" name="bindings" extra="关联项目共享同一份知识内容；不会自动扫描或调用模型。">
        <Select aria-label="关联项目" mode="multiple" placeholder="可不关联项目" options={projects.map((project) => ({ value: project.cwd, label: project.name }))} />
      </Form.Item>
    </Form>
  </Modal>;
}
