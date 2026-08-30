import { Button, Modal } from '@lobehub/ui';
import { Segmented, Select } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { KeyValueEditor, type KvPairs } from './KeyValueEditor';
import { getToolPerm, getToolRules, shortToolName, type Perm, type RuleItem, type RulePolicy } from './mcpPolicy';

interface ToolPermissionModalProps {
  open: boolean;
  fullName: string;
  policyRaw: Record<string, unknown>;
  onSave: (fullName: string, perm: Perm, rules: RuleItem[]) => void;
  onClose: () => void;
}

interface EditRule {
  match: KvPairs;
  policy: RulePolicy;
}

const PERM_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '需审批', value: 'needs_approval' },
  { label: '禁用', value: 'disabled' },
];

const POLICY_OPTIONS = [
  { label: '免审 (never)', value: 'never' },
  { label: '需审 (required)', value: 'required' },
  { label: '必审 (always)', value: 'always' },
];

function toEdit(rules: RuleItem[]): EditRule[] {
  return rules.map((r) => ({ match: Object.entries(r.match ?? {}), policy: r.policy }));
}

function fromEdit(edits: EditRule[]): RuleItem[] {
  return edits.map((e) => {
    const match: Record<string, string> = {};
    for (const [k, v] of e.match) if (k.trim()) match[k] = v;
    const item: RuleItem = { policy: e.policy };
    if (Object.keys(match).length) item.match = match;
    return item;
  });
}

const styles = createStaticStyles(({ css }) => ({
  section: css`
    margin-block-end: 16px;
  `,
  label: css`
    display: block;
    margin-block-end: 8px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  rule: css`
    padding: 10px;
    margin-block-end: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 10px;
  `,
  ruleHead: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-block-end: 8px;
  `,
  rm: css`
    display: inline-flex;
    border: none;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;
  `,
  add: css`
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: none;
    background: transparent;
    color: ${cssVar.colorPrimary};
    font-size: 12px;
    cursor: pointer;
  `,
  foot: css`
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-block-start: 16px;
  `,
  hint: css`
    margin-block-end: 12px;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

export function ToolPermissionModal({ open, fullName, policyRaw, onSave, onClose }: ToolPermissionModalProps) {
  const [perm, setPerm] = useState<Perm>('auto');
  const [rules, setRules] = useState<EditRule[]>([]);

  useEffect(() => {
    if (!open) return;
    setPerm(getToolPerm(policyRaw, fullName));
    setRules(toEdit(getToolRules(policyRaw, fullName)));
  }, [open, fullName, policyRaw]);

  const setRuleMatch = (i: number, match: KvPairs) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, match } : r)));
  const setRulePolicy = (i: number, policy: RulePolicy) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, policy } : r)));
  const removeRule = (i: number) => setRules((rs) => rs.filter((_, j) => j !== i));
  const addRule = () => setRules((rs) => [...rs, { match: [], policy: 'required' }]);

  return (
    <Modal open={open} title={`工具权限 · ${shortToolName(fullName)}`} footer={null} onCancel={onClose} data-testid="tool-perm-modal">
      <div className={styles.hint}>{fullName}</div>

      <div className={styles.section}>
        <label className={styles.label}>权限</label>
        <Segmented
          value={perm}
          options={PERM_OPTIONS}
          onChange={(v) => setPerm(v as Perm)}
          data-testid="tool-perm-segmented"
        />
      </div>

      <div className={styles.section}>
        <label className={styles.label}>参数规则（按顺序匹配，第一个命中生效）</label>
        {rules.map((r, i) => (
          <div key={i} className={styles.rule} data-testid={`tool-rule-${i}`}>
            <div className={styles.ruleHead}>
              <Select
                size="small"
                value={r.policy}
                options={POLICY_OPTIONS}
                onChange={(v) => setRulePolicy(i, v as RulePolicy)}
                style={{ width: 160 }}
                data-testid={`tool-rule-policy-${i}`}
              />
              <button type="button" className={styles.rm} onClick={() => removeRule(i)} data-testid={`tool-rule-rm-${i}`}>
                <Trash2 size={14} />
              </button>
            </div>
            <KeyValueEditor
              value={r.match}
              onChange={(v) => setRuleMatch(i, v)}
              keyPlaceholder="参数名 (如 path)"
              valuePlaceholder="匹配 (支持 *)"
              addText="添加匹配条件"
              testId={`tool-rule-match-${i}`}
            />
          </div>
        ))}
        <button type="button" className={styles.add} onClick={addRule} data-testid="tool-rule-add">
          <Plus size={13} />
          添加规则
        </button>
      </div>

      <div className={styles.foot}>
        <Button onClick={onClose}>取消</Button>
        <Button type="primary" data-testid="tool-perm-save" onClick={() => { onSave(fullName, perm, fromEdit(rules)); onClose(); }}>
          保存
        </Button>
      </div>
    </Modal>
  );
}
