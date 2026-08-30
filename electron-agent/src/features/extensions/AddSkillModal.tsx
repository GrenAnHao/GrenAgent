import { Button, Modal } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { useEffect, useState } from 'react';

interface AddSkillModalProps {
  open: boolean;
  existingNames: string[];
  onSubmit: (name: string, description: string, body: string) => Promise<void>;
  onClose: () => void;
}
const NAME_RE = /^[a-zA-Z0-9._-]+$/;

const styles = createStaticStyles(({ css }) => ({
  field: css`
    margin-block-end: 14px;
  `,
  label: css`
    display: block;
    margin-block-end: 6px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  hint: css`
    margin-block-start: 4px;
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  input: css`
    width: 100%;
    padding: 9px 11px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 9px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;

    &:focus {
      border-color: ${cssVar.colorPrimary};
      outline: none;
    }
  `,
  desc: css`
    width: 100%;
    min-height: 72px;
    padding: 10px 11px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 9px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    font-size: 13px;
    line-height: 1.5;
    resize: vertical;

    &:focus {
      border-color: ${cssVar.colorPrimary};
      outline: none;
    }
  `,
  body: css`
    width: 100%;
    min-height: 200px;
    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
    background: ${cssVar.colorFillQuaternary};
    color: ${cssVar.colorText};
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.55;
    resize: vertical;

    &:focus {
      border-color: ${cssVar.colorPrimary};
      outline: none;
    }
  `,
  error: css`
    margin-block-end: 10px;
    color: ${cssVar.colorError};
    font-size: 12px;
  `,
  foot: css`
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-block-start: 16px;
  `,
}));

const BODY_PLACEHOLDER = `用 Markdown 描述这个技能怎么用、分几步做。例如：

Use this skill when the user asks about X.

## Steps
1. ...
2. ...`;

export function AddSkillModal({ open, existingNames, onSubmit, onClose }: AddSkillModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setBody('');
    setError(null);
    setSubmitting(false);
  }, [open]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请填写技能名称');
      return;
    }
    if (!NAME_RE.test(trimmed)) {
      setError('技能名称只能包含字母、数字、连字符、下划线和点');
      return;
    }
    if (existingNames.includes(trimmed)) {
      setError(`技能 "${trimmed}" 已存在`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed, description.trim(), body);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} title="新增技能" footer={null} onCancel={onClose} data-testid="add-skill-modal">
      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.field}>
        <label className={styles.label}>技能名称 *</label>
        <input
          className={styles.input}
          data-testid="skill-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-skill"
        />
        <div className={styles.hint}>会创建到 ~/.agents/skills/&lt;名称&gt;/SKILL.md，可用 /skill:名称 调用。</div>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>描述</label>
        <textarea
          className={styles.desc}
          data-testid="skill-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="一句话说明这个技能做什么、什么时候用（写进 frontmatter，agent 据此自动加载）。"
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>正文 (SKILL.md)</label>
        <textarea
          className={styles.body}
          data-testid="skill-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={BODY_PLACEHOLDER}
        />
      </div>

      <div className={styles.foot}>
        <Button onClick={onClose}>取消</Button>
        <Button type="primary" data-testid="skill-submit" loading={submitting} onClick={() => void submit()}>
          创建
        </Button>
      </div>
    </Modal>
  );
}
