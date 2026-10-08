import { Button, Flexbox } from '@lobehub/ui';
import { App, Input, Popconfirm, Segmented, Switch, Tooltip } from 'antd';
import { Plus, TriangleAlert } from 'lucide-react';
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
import { errorText } from './errorText';
import { libraryStyles as styles } from './libraryStyles';

type Filter = 'all' | RuleScope;

interface RuleDraft {
  original?: RuleRef;
  scope: RuleScope;
  title: string;
  enabled: boolean;
  body: string;
}

const SCOPE_LABEL: Record<RuleScope, string> = { global: '全局', project: '项目' };

function draftOf(rule: RuleInfo): RuleDraft {
  return { original: { scope: rule.scope, id: rule.id }, scope: rule.scope, title: rule.title, enabled: rule.enabled, body: rule.body };
}

function sameRule(draft: RuleDraft | null, rule: RuleInfo): boolean {
  return draft?.original?.scope === rule.scope && draft.original.id === rule.id;
}

export function RulesPanel({ workspace }: { workspace: string }) {
  const { message } = App.useApp();
  const [rules, setRules] = useState<RuleInfo[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [draft, setDraft] = useState<RuleDraft | null>(null);
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
      const saved = await saveContextRule({ workspace, ...draft });
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
      await reload();
    } catch (error) {
      report(error);
    }
  };

  const visible = rules.filter((rule) => filter === 'all' || rule.scope === filter);
  const canSave = Boolean(draft && draft.title.trim() && draft.body.trim() && (draft.scope === 'global' || workspace));

  return (
    <>
      <div className={styles.heroBar}>
        <span className={styles.heroTitle}>规则</span>
        <Button type="primary" size="small" icon={<Plus size={14} />} data-testid="rule-new" onClick={() => setDraft({ scope: 'global', title: '', enabled: true, body: '' })}>
          新建
        </Button>
      </div>
      <div className={styles.desc}>
        启用的规则在每次发送时放进上下文。全局规则在 ~/.pi/agent/rules，项目规则在工作区的 .pi/rules。
      </div>
      <div className={styles.split}>
        <div className={styles.list}>
          <Segmented<Filter>
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
              <div key={key} className={styles.rowWrap} data-testid={`rule-item-${key}`} data-active={sameRule(draft, rule)}>
                <Switch size="small" checked={rule.enabled} disabled={Boolean(rule.error)} data-testid={`rule-toggle-${key}`} onChange={(checked) => void toggle(rule, checked)} />
                <button type="button" className={styles.rowOpen} data-testid={`rule-open-${key}`} onClick={() => setDraft(draftOf(rule))}>
                  <span className={styles.ellipsis}>{rule.title}</span>
                  {rule.error ? (
                    <Tooltip title={rule.error}>
                      <TriangleAlert size={14} className={styles.warn} data-testid={`rule-warning-${key}`} />
                    </Tooltip>
                  ) : null}
                  <span className={styles.badge}>{SCOPE_LABEL[rule.scope]}</span>
                </button>
              </div>
            );
          })}
          <div className={styles.listNote}>Pi 自己还会读 AGENTS.md / CLAUDE.md，这里不管它们。</div>
        </div>
        <div className={styles.edit}>
          {draft ? (
            <>
              <div>
                <div className={styles.label}>名称</div>
                <Input data-testid="rule-title-input" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              </div>
              <div>
                <div className={styles.label}>范围</div>
                <Segmented<RuleScope>
                  size="small"
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
              </div>
              <div>
                <div className={styles.label}>规则内容（Markdown，启用时每轮注入上下文）</div>
                <Input.TextArea data-testid="rule-body-input" autoSize={{ minRows: 6, maxRows: 18 }} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
              </div>
              <Flexbox horizontal gap={8}>
                <Button type="primary" size="small" data-testid="rule-save" disabled={!canSave} loading={saving} onClick={() => void save()}>保存</Button>
                {draft.original ? (
                  <Popconfirm title="删除这条规则？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void remove()}>
                    <Button size="small" danger data-testid="rule-delete">删除</Button>
                  </Popconfirm>
                ) : null}
              </Flexbox>
            </>
          ) : (
            <div className={styles.empty}>选一条规则，或点「新建」</div>
          )}
        </div>
      </div>
    </>
  );
}
