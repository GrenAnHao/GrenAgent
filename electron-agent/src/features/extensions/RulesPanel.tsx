import { Button } from '@lobehub/ui';
import { App, Input, Popconfirm, Segmented, Switch, Tooltip } from 'antd';
import { ArrowLeft, Plus, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteContextRule,
  listContextRules,
  saveContextRule,
  setContextRuleEnabled,
  type RuleInfo,
  type RuleRef,
  type RuleScope,
} from '../../lib/promptLibraryIo';
import { AGENT_MODES, MODE_LABELS, type AgentMode } from '../../stores/modeStore';
import { errorText } from './errorText';
import { libraryStyles as styles } from './libraryStyles';
import { ExtensionPageHeader } from './ExtensionPageHeader';
import { useAskConfirm } from '../../components/askConfirm';

type Filter = 'all' | RuleScope;

interface RuleDraft {
  original?: RuleRef;
  scope: RuleScope;
  title: string;
  enabled: boolean;
  body: string;
  /** 适用模式；undefined / 空 = 所有模式。 */
  modes?: AgentMode[];
}

const SCOPE_LABEL: Record<RuleScope, string> = { global: '全局', project: '项目' };
const SCOPE_DIR: Record<RuleScope, string> = { global: '~/.pi/agent/rules', project: '.pi/rules' };

function sameModes(a: AgentMode[] | undefined, b: AgentMode[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((mode) => right.includes(mode));
}

/** 开关当场写盘，不算未保存；名称、范围、模式、正文和磁盘版本比。新建的填了标题或正文就算改过。 */
function isRuleDirty(draft: RuleDraft | null, saved: RuleInfo | undefined): boolean {
  if (!draft) return false;
  if (!saved) return Boolean(draft.title || draft.body);
  return draft.title !== saved.title || draft.body !== saved.body || draft.scope !== saved.scope || !sameModes(draft.modes, saved.modes);
}

function draftOf(rule: RuleInfo): RuleDraft {
  return {
    original: { scope: rule.scope, id: rule.id },
    scope: rule.scope,
    title: rule.title,
    enabled: rule.enabled,
    body: rule.body,
    ...(rule.modes && rule.modes.length > 0 ? { modes: [...rule.modes] } : {}),
  };
}

function modeSummary(modes: AgentMode[] | undefined): string {
  if (!modes || modes.length === 0) return '全部模式';
  return modes.map((mode) => MODE_LABELS[mode]).join('、');
}

/** 选中 / 取消一个模式；全取消就是「所有模式」（不存范围）。顺序按模式枚举走，写盘结果稳定。 */
function toggleDraftMode(draft: RuleDraft, mode: AgentMode): RuleDraft {
  const picked = new Set(draft.modes ?? []);
  if (picked.has(mode)) picked.delete(mode);
  else picked.add(mode);
  const next = AGENT_MODES.filter((m) => picked.has(m));
  const { modes: _drop, ...rest } = draft;
  return next.length > 0 ? { ...rest, modes: next } : rest;
}

function sameRule(draft: RuleDraft | null, rule: RuleInfo): boolean {
  return draft?.original?.scope === rule.scope && draft.original.id === rule.id;
}

export function RulesPanel({ workspace }: { workspace: string }) {
  const { message } = App.useApp();
  const ask = useAskConfirm();
  const [rules, setRules] = useState<RuleInfo[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestSeq = useRef(0);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  const report = useCallback((error: unknown) => {
    message.error(errorText(error));
  }, [message]);

  const reload = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const list = await listContextRules(workspace);
      if (seq === requestSeq.current) setRules(list);
    } catch (error) {
      if (seq === requestSeq.current) report(error);
    }
  }, [workspace, report]);

  useEffect(() => {
    setDraft(null);
    setMobileDetail(false);
  }, [workspace]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = async (rule: RuleInfo, enabled: boolean) => {
    const started = workspace;
    try {
      await setContextRuleEnabled(workspace, { scope: rule.scope, id: rule.id }, enabled);
      if (workspaceRef.current !== started) return;
      setDraft((current) => (current && sameRule(current, rule) ? { ...current, enabled } : current));
      await reload();
    } catch (error) {
      if (workspaceRef.current === started) report(error);
    }
  };

  const save = async () => {
    if (!draft || saving) return;
    const started = workspace;
    setSaving(true);
    try {
      const saved = await saveContextRule({
        workspace,
        ...draft,
        modes: draft.modes && draft.modes.length > 0 ? draft.modes : undefined,
      });
      if (workspaceRef.current !== started) return;
      setDraft(draftOf(saved));
      await reload();
      message.success('已保存');
    } catch (error) {
      if (workspaceRef.current === started) report(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.original) return;
    try {
      await deleteContextRule(workspace, draft.original);
      setDraft(null);
      setMobileDetail(false);
      await reload();
    } catch (error) {
      report(error);
    }
  };

  const visible = rules.filter((rule) => filter === 'all' || rule.scope === filter);
  const selectedRule = rules.find((rule) => sameRule(draft, rule));
  const dirty = isRuleDirty(draft, selectedRule);
  const canSave = Boolean(draft && dirty && draft.title.trim() && draft.body.trim() && (draft.scope === 'global' || workspace));

  /** 有未保存的修改时先问一句，确定才换掉草稿；没改过就直接换，不等确认框。 */
  const openDraft = (next: RuleDraft) => {
    const apply = () => {
      setDraft(next);
      setMobileDetail(true);
    };
    if (!dirty) {
      apply();
      return;
    }
    void ask({ title: '放弃未保存的修改？', content: '当前规则的修改还没保存，换走后会丢失。', danger: true }).then((ok) => { if (ok) apply(); });
  };

  return (
    <>
      <ExtensionPageHeader
        title="规则"
        count={rules.length}
        description="为 Agent 设置持续生效的工作约定，启用后发送时加入上下文。AGENTS.md / CLAUDE.md 由 Pi 自行读取。"
        actions={<Button type="primary" icon={<Plus size={15} />} data-testid="rule-new" onClick={() => openDraft({ scope: 'global', title: '', enabled: true, body: '' })}>新建规则</Button>}
      />
      <div className={styles.split} data-testid="rule-workbench" data-mobile-detail={mobileDetail}>
        <div className={styles.list} data-testid="rule-list" data-library-list>
          <Segmented<Filter>
            className={styles.filters}
            block
            size="small"
            value={filter}
            onChange={setFilter}
            options={[
              { label: <span data-testid="rule-filter-all">全部</span>, value: 'all' },
              { label: <span data-testid="rule-filter-global">全局</span>, value: 'global' },
              { label: <span data-testid="rule-filter-project">项目</span>, value: 'project' },
            ]}
          />
          {visible.length === 0 ? <div className={styles.empty}>还没有规则</div> : null}
          {visible.map((rule) => {
            const key = `${rule.scope}-${rule.id}`;
            return (
              <div key={key} className={styles.rowWrap} data-testid={`rule-item-${key}`} data-active={sameRule(draft, rule)} data-enabled={rule.enabled}>
                <Switch size="small" checked={rule.enabled} disabled={Boolean(rule.error)} aria-label={`启用${rule.title}`} data-testid={`rule-toggle-${key}`} onChange={(checked) => void toggle(rule, checked)} />
                <button
                  type="button"
                  className={styles.rowOpen}
                  data-testid={`rule-open-${key}`}
                  aria-pressed={sameRule(draft, rule)}
                  onClick={() => {
                    if (sameRule(draft, rule)) setMobileDetail(true);
                    else openDraft(draftOf(rule));
                  }}
                >
                  <span className={styles.itemTop}>
                    <span className={styles.ellipsis}>{rule.title}</span>
                    {rule.error ? (
                      <Tooltip title={rule.error}>
                        <TriangleAlert size={15} className={styles.warn} data-testid={`rule-warning-${key}`} />
                      </Tooltip>
                    ) : null}
                  </span>
                  <span className={styles.ruleMeta}><span data-testid={`rule-origin-${key}`}>{SCOPE_LABEL[rule.scope]}</span><span>·</span><span className={styles.modesBadge} data-testid={`rule-modes-${key}`}>{modeSummary(rule.modes)}</span></span>
                </button>
              </div>
            );
          })}
        </div>
        <div className={styles.edit} data-testid="rule-editor" data-library-editor>
          <button type="button" className={styles.back} data-testid="rule-back" onClick={() => setMobileDetail(false)}><ArrowLeft size={14} />返回列表</button>
          {draft ? (
            <>
              <div className={styles.editorHeading}>
                <h3>{draft.title || '新建规则'}</h3>
                {dirty ? <span className={styles.dirty} data-testid="rule-dirty">未保存</span> : null}
                <label className={styles.switchLabel}>
                  <Switch size="small" checked={draft.enabled} disabled={Boolean(selectedRule?.error)} aria-label="启用当前规则" data-testid="rule-detail-toggle" onChange={(enabled) => selectedRule ? void toggle(selectedRule, enabled) : setDraft({ ...draft, enabled })} />
                  <span>{draft.enabled ? '已启用' : '已停用'}</span>
                </label>
              </div>
              <div className={styles.sectionHeading}>基本信息<span>{draft.original ? '开关立即生效，其他修改需保存' : '保存后生效'}</span></div>
              <div>
                <div className={styles.label}>名称</div>
                <Input aria-label="规则名称" data-testid="rule-title-input" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              </div>
              <div className={styles.formRow}>
                <div>
                  <div className={styles.label}>范围</div>
                  <Segmented<RuleScope>
                    value={draft.scope}
                    onChange={(scope) => setDraft({ ...draft, scope })}
                    options={[
                      { label: <span data-testid="rule-scope-global">全局</span>, value: 'global' },
                      {
                        label: (
                          <Tooltip title={workspace ? undefined : '先打开工作区'}>
                            <span data-testid="rule-scope-project" aria-disabled={!workspace}>项目</span>
                          </Tooltip>
                        ),
                        value: 'project',
                        disabled: !workspace,
                      },
                    ]}
                  />
                  <div className={styles.scopePath} data-testid="rule-scope-path">保存到 <code>{SCOPE_DIR[draft.scope]}</code></div>
                </div>
                <div>
                  <div className={styles.label}>适用模式</div>
                  <div className={styles.modePicker} role="group" aria-label="适用模式">
                    <button
                      type="button"
                      className={styles.modeChip}
                      data-testid="rule-mode-all"
                      data-active={!draft.modes?.length}
                      aria-pressed={!draft.modes?.length}
                      onClick={() => setDraft((current) => {
                        if (!current) return current;
                        const { modes: _drop, ...rest } = current;
                        return rest;
                      })}
                    >
                      全部
                    </button>
                    {AGENT_MODES.map((mode) => {
                      const active = Boolean(draft.modes?.includes(mode));
                      return (
                        <button
                          key={mode}
                          type="button"
                          className={styles.modeChip}
                          data-testid={`rule-mode-${mode}`}
                          data-active={active}
                          aria-pressed={active}
                          onClick={() => setDraft((current) => (current ? toggleDraftMode(current, mode) : current))}
                        >
                          {MODE_LABELS[mode]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className={styles.fillField}>
                <div className={styles.sectionHeading}>规则正文<span>Markdown</span></div>
                <Input.TextArea className={styles.fillArea} style={{ resize: 'none' }} aria-label="规则内容" data-testid="rule-body-input" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
              </div>
              <div className={styles.footer}>
                {draft.original ? (
                  <Popconfirm title="删除这条规则？" okText="删除" cancelText="取消" okButtonProps={{ danger: true, autoInsertSpace: false }} onConfirm={() => void remove()}>
                    <Button danger autoInsertSpace={false} data-testid="rule-delete">删除</Button>
                  </Popconfirm>
                ) : null}
                <Button className={styles.saveButton} type="primary" data-testid="rule-save" disabled={!canSave} loading={saving} onClick={() => void save()}>保存规则</Button>
              </div>
            </>
          ) : (
            <div className={styles.empty}>选一条规则，或点「新建规则」</div>
          )}
        </div>
      </div>
    </>
  );
}
