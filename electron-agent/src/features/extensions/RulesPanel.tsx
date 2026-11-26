import { WorkbenchButton as Button } from '../../components/WorkbenchButton';
import { App, Input, Popconfirm, Segmented, Switch, Tooltip } from 'antd';
import { ArrowLeft, Copy, FolderOpen, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteContextRule,
  listContextRules,
  extensionDirectory,
  openBuiltinDirectory,
  saveBuiltinRule,
  saveContextRule,
  setContextRuleEnabled,
  type RuleInfo,
  type RuleRef,
  type RuleScope,
} from '../../lib/promptLibraryIo';
import { AGENT_MODES, MODE_LABELS, type AgentMode } from '../../stores/modeStore';
import { detectLineSeparator } from '../fileExplorer/fileKinds';
import { LazyMarkdown } from '../chat/LazyMarkdown';
import { promptBudget } from './promptBudget';
import { errorText } from './errorText';
import { libraryStyles as styles } from './libraryStyles';
import { ExtensionPageHeader } from './ExtensionPageHeader';
import { useAskConfirm } from '../../components/askConfirm';

import { RuleCatalog, modeSummary, repositoryLabels, scopeLabel, type RuleFilter } from './RuleCatalog';
import { ruleStyles as s } from './ruleStyles';
import { copyText } from './McpConfigValues';

interface RuleDraft {
  original?: RuleRef;
  scope: RuleScope;
  title: string;
  enabled: boolean;
  body: string;
  /** 适用模式；undefined / 空 = 所有模式。 */
  modes?: AgentMode[];
  globText?: string;
  builtin?: RuleInfo;
}

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
  return draft.title !== saved.title || draft.body !== saved.body || draft.scope !== saved.scope || !sameModes(draft.modes, saved.modes) || (draft.globText ?? '') !== (saved.globs ?? []).join('\n');
}

function draftOf(rule: RuleInfo): RuleDraft {
  return {
    original: { scope: rule.scope, id: rule.id },
    scope: rule.scope,
    title: rule.title,
    enabled: rule.enabled,
    body: rule.body,
    ...(rule.globs?.length && { globText:rule.globs.join('\n') }),
    ...(rule.builtinProject && { builtin:rule }),
    ...(rule.modes && rule.modes.length > 0 ? { modes: [...rule.modes] } : {}),
  };
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

function matchesSearch(rule: RuleInfo, term: string): boolean {
  return !term || [rule.title, rule.path, rule.body].some(value => value.toLowerCase().includes(term));
}

function sameRule(draft: RuleDraft | null, rule: RuleInfo): boolean {
  return draft?.original?.scope === rule.scope && draft.original.id === rule.id;
}

export function RulesPanel({ workspace, onResourcesChanged }: { workspace: string; onResourcesChanged?: () => void }) {
  return <RuleLibrary key={workspace} workspace={workspace} onResourcesChanged={onResourcesChanged} />;
}
function RuleLibrary({ workspace, onResourcesChanged }: { workspace: string; onResourcesChanged?: () => void }) {
  const { message } = App.useApp();
  const ask = useAskConfirm();
  const [rules, setRules] = useState<RuleInfo[]>([]);
  const [filter, setFilter] = useState<RuleFilter>('all');
  const [explicit, setDraft] = useState<RuleDraft | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [preview, setPreview] = useState(false);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestSeq = useRef(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; requestSeq.current++; }; }, []);
  const term = query.trim().toLowerCase();
  const matches = useMemo(() => term ? rules.filter(rule => matchesSearch(rule, term)) : rules, [rules, term]);
  const visible = matches.filter((rule) => filter === 'all' || rule.scope === filter);
  const viewing = visible.find(rule => sameRule(explicit, rule)) ?? visible[0];
  const draft = editing ? explicit : viewing ? draftOf(viewing) : null;
  const selectedRule = rules.find((rule) => sameRule(draft, rule));
  const dirty = editing && isRuleDirty(draft, draft?.builtin ?? selectedRule);
  const builtin = draft?.builtin;
  const budget = useMemo(() => promptBudget(rules.filter((r) => r.scope === 'global' && r.enabled && !r.error).map((r) => r.body).join('')), [rules]);
  const projects = useMemo(() => repositoryLabels(rules), [rules]);
  const fileBudget = useMemo(() => promptBudget(draft?.body ?? ''), [draft?.body]);
  const canSave = !!draft && editing && dirty && (builtin ? !builtin.readOnly :
    !!(draft.title.trim() && draft.body.trim() && (draft.scope === 'global' || workspace)));

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
    void reload();
  }, [reload]);

  const toggle = async (rule: RuleInfo, enabled: boolean) => {
    try {
      await setContextRuleEnabled(workspace, { scope: rule.scope, id: rule.id }, enabled);
      if (!live.current) return;
      setDraft((current) => (current && sameRule(current, rule) ? { ...current, enabled } : current));
      await reload();
    } catch (error) {
      if (live.current) report(error);
    }
  };

  const save = async () => {
    if (!draft || !canSave || saving) return;
    setSaving(true);
    try {
      let saved: RuleInfo;
      if (builtin) {
        const content = draft.body.replace(/\r?\n/g, detectLineSeparator(builtin.body));
        await saveBuiltinRule(workspace, builtin.path, builtin.body, content);
        saved = { ...builtin, body: content };
      } else {
        saved = await saveContextRule({
          workspace, scope: draft.scope, original: draft.original, title: draft.title,
          enabled: draft.enabled, body: draft.body,
          globs: draft.globText?.split(/\r?\n/).map(p => p.trim()).filter(Boolean),
          modes: draft.modes?.length ? draft.modes : undefined,
        });
      }
      if (!live.current) return;
      // 正文或范围可能正好是筛选条件。保存后仍然预览刚写入的文件，不跳到另一份同名规则。
      if (!matchesSearch(saved, term)) setQuery('');
      if (filter !== 'all' && saved.scope !== filter) setFilter(saved.scope);
      setRules(previous => previous.some(rule => sameRule(draft, rule))
        ? previous.map(rule => sameRule(draft, rule) ? saved : rule) : [...previous, saved]);
      setDraft(draftOf(saved));
      await reload();
      if (!live.current) return;
      setEditing(false);
      if (builtin) onResourcesChanged?.();
      message.success(builtin ? '项目文件已保存' : '已保存');
    } catch (error) {
      if (live.current) report(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.original || builtin || saving) return;
    setSaving(true);
    try {
      await deleteContextRule(workspace, draft.original);
      if (!live.current) return;
      setDraft(null); setEditing(false);
      setMobileDetail(false);
      await reload();
    } catch (error) {
      if (live.current) report(error);
    } finally { setSaving(false); }
  };

  const locate = () => builtin ? openBuiltinDirectory(workspace, builtin.path)
    : extensionDirectory('rules', (selectedRule?.scope ?? draft?.scope ?? filter) === 'project' ? workspace : '', true);
  const changeFilter = async (next: RuleFilter) => {
    if (dirty && !await ask({title:'放弃未保存的修改？', content:'切换范围会离开当前规则。', danger:true})) return;
    setFilter(next); setDraft(null); setMobileDetail(false); setEditing(false); setPreview(false);
  };
  const cancelEdit = async () => {
    if (dirty && !await ask({title:'放弃未保存的修改？', danger:true})) return;
    setDraft(selectedRule ? draftOf(selectedRule) : null); setEditing(false); setPreview(false);
    if (!selectedRule) setMobileDetail(false);
  };

  /** 有未保存的修改时先问一句，确定才换掉草稿；没改过就直接换，不等确认框。 */
  const openDraft = (next: RuleDraft) => {
    const apply = () => {
      setDraft(next); setPreview(false); setEditing(!next.original);
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
        id="rule" title="规则" onRefresh={async () => {
          if (saving || (dirty && !await ask({title:'放弃修改并刷新规则？', danger:true}))) return;
          const selected = draft?.original;
          const seq = ++requestSeq.current;
          const list = await listContextRules(workspace);
          if (seq !== requestSeq.current) return;
          setRules(list); const next = list.find((r) => selected?.id === r.id && selected.scope === r.scope);
          setDraft(next ? draftOf(next) : null); setEditing(false);
        }} onDirectory={locate} count={rules.length}
        description={<span className={s.numeric} data-testid="rule-global-budget">
          <span title="只计已启用的全局规则正文；带模式或文件条件的规则仅在匹配时注入。">全局常驻已启用：{budget.characters.toLocaleString()} 字 (≈ {budget.tokens.toLocaleString()} tokens)</span>
          {' · '}项目内置规则 ({projects.size.toLocaleString()} 个仓库) 将在对应项目会话中按需注入
        </span>}
        actions={<Button type="primary" icon={<Plus size={15} />} disabled={saving} data-testid="rule-new" onClick={() => openDraft({ scope: filter === 'project' && workspace ? 'project' : 'global', title: '', enabled: true, body: '' })}>新建规则</Button>}
      />
      <div className={styles.split + ' ' + s.split} data-testid="rule-workbench" data-mobile-detail={mobileDetail}
        onKeyDown={event => {
          if (editing && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
            event.preventDefault(); event.stopPropagation(); if (!event.repeat) void save();
          }
        }}>
        <RuleCatalog query={query} onQuery={value => { setQuery(value); if (!editing) setDraft(null); }}
          projects={projects} filter={filter} onFilter={changeFilter} matches={matches} visible={visible} selected={selectedRule}
          busy={saving} onToggle={toggle} onSelect={rule => {
            if (sameRule(draft, rule)) { setDraft(draft); setMobileDetail(true); }
            else openDraft(draftOf(rule));
          }} />
        <div className={styles.edit} data-testid="rule-editor" data-library-editor>
          <button type="button" className={styles.back} data-testid="rule-back" onClick={() => setMobileDetail(false)}><ArrowLeft size={14} />返回列表</button>
          {draft ? <>
            <header className={s.head}>
              <div className={s.headline}>
                <div className={s.identity}>
                  <h3 data-testid="rule-detail-title">{draft.title || '新建规则'}</h3>
                  {(!selectedRule?.error || editing) && <span className={s.badge + ' ' + s.budget} data-testid="rule-file-budget"
                    title="当前 Markdown 正文的字符数与估算 token 数；不含元信息。">
                    {fileBudget.characters.toLocaleString()} 字 · ≈ {fileBudget.tokens.toLocaleString()} tokens
                  </span>}
                  {dirty && <span className={styles.dirty} data-testid="rule-dirty">未保存</span>}
                </div>
                <div className={s.actions} role="group" aria-label="规则操作">
                  {!builtin && <label className={styles.switchLabel}>
                    <Switch size="small" checked={draft.enabled} disabled={saving || !!selectedRule?.error} aria-label="启用当前规则" data-testid="rule-detail-toggle" onChange={(enabled) => selectedRule ? void toggle(selectedRule, enabled) : setDraft({ ...draft, enabled })} />
                    <span>{draft.enabled ? '已启用' : '已停用'}</span>
                  </label>}
                  <Tooltip title="复制全文"><Button size="small" type="text" aria-label="复制全文" disabled={!!builtin?.error} icon={<Copy size={15} />}
                    onClick={() => void copyText(draft.body, message, '已复制全文')} /></Tooltip>
                  {draft.original && <Tooltip title="定位文件"><Button size="small" type="text" aria-label="定位文件" icon={<FolderOpen size={15} />}
                    onClick={() => void locate().catch(report)} /></Tooltip>}
                  {draft.original && !builtin && <Popconfirm title={'删除「' + (selectedRule?.title ?? draft.title) + '」？'} okText="删除" cancelText="取消" okButtonProps={{ danger: true, autoInsertSpace: false }} onConfirm={() => void remove()}>
                    <Button size="small" type="text" danger disabled={saving} aria-label="删除规则" title="删除规则" data-testid="rule-delete" icon={<Trash2 size={15} />} />
                  </Popconfirm>}
                  {editing ? <>
                    <Button size="small" type="text" disabled={saving} autoInsertSpace={false} onClick={() => void cancelEdit()}>取消</Button>
                    <Button size="small" type="primary" autoInsertSpace={false} icon={<Save size={14}/>} title="保存 (Ctrl+S)" data-testid={builtin ? 'builtin-save' : 'rule-save'} disabled={!canSave} loading={saving} onClick={() => void save()}>保存</Button>
                  </> : <Button size="small" autoInsertSpace={false} icon={<Pencil size={14} />} disabled={builtin?.readOnly} data-testid={builtin ? 'builtin-edit' : 'rule-edit'}
                    onClick={() => { setDraft(draft); setPreview(false); setEditing(true); }}>{builtin?.readOnly ? '只读' : '编辑'}</Button>}
                </div>
              </div>
              <div className={s.metadata}>
                <span className={s.badge}>{builtin ? '项目内置' : scopeLabel[draft.scope] + '规则'}</span>
                {builtin ? <span className={s.badge}>{builtin.error ? '无法读取' : builtin.enabled ? '会话自动注入' : '同目录中其他指令优先'}</span>
                  : <><span className={s.badge}>{modeSummary(draft)}</span>{draft.globText && <span className={s.badge} title={draft.globText}>Glob 匹配</span>}</>}
              </div>
              {selectedRule?.path && <button type="button" className={s.path} aria-label="复制文件路径" title="点击复制完整路径"
                onClick={() => void copyText(selectedRule.path, message, '已复制文件路径')}><code>{selectedRule.path}</code><Copy size={12} /></button>}
            </header>
            {selectedRule?.error && <div className={styles.error}>{selectedRule.error}</div>}
            {!editing ? <div key={selectedRule?.path} className={s.document} data-testid={builtin ? 'builtin-preview' : 'rule-preview'}><LazyMarkdown enableMermaid={false}>{draft.body}</LazyMarkdown></div>
            : builtin ? <Input.TextArea autoFocus disabled={saving} spellCheck={false} className={s.source} value={draft.body} aria-label="项目规则内容" data-testid="builtin-body"
              onChange={event => setDraft({...draft, body:event.target.value})} /> : <div className={styles.formScroll} data-testid="rule-form-scroll">
              <div className={styles.sectionHeading}>基本信息<span>{draft.original ? '开关立即生效，其他修改需保存' : '保存后生效'}</span></div>
              <div>
                <div className={styles.label}>名称</div>
                <Input autoFocus aria-label="规则名称" data-testid="rule-title-input" disabled={saving} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              </div>
              <div className={styles.formRow}>
                <div>
                  <div className={styles.label}>范围</div>
                  <Segmented<RuleScope>
                    disabled={saving} value={draft.scope}
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
                  <div className={styles.scopePath} data-testid="rule-scope-path">保存到 <code>{selectedRule?.scope === draft.scope ? selectedRule.path : draft.scope === 'project' ? workspace + (workspace.includes('\\') ? '\\.pi\\rules' : '/.pi/rules') : SCOPE_DIR.global}</code></div>
                </div>
                <div>
                  <div className={styles.label}>适用模式</div>
                  <div className={styles.modePicker} role="group" aria-label="适用模式">
                    <button
                      type="button"
                      disabled={saving} className={styles.modeChip}
                      data-testid="rule-mode-all"
                      data-active={!draft.modes?.length}
                      aria-pressed={!draft.modes?.length}
                      onClick={() => setDraft({ ...draft, modes:undefined })}
                    >
                      全部
                    </button>
                    {AGENT_MODES.map((mode) => {
                      const active = Boolean(draft.modes?.includes(mode));
                      return (
                        <button
                          key={mode}
                          type="button"
                          disabled={saving} className={styles.modeChip}
                          data-testid={`rule-mode-${mode}`}
                          data-active={active}
                          aria-pressed={active}
                          onClick={() => setDraft(toggleDraftMode(draft, mode))}
                        >
                          {MODE_LABELS[mode]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div><div className={styles.label}>匹配文件 <small>（Glob，每行一个；留空匹配全部）</small></div>
                <Input.TextArea disabled={saving} autoSize={{minRows:1,maxRows:3}} aria-label="Glob 文件匹配" placeholder="例如 src/**/*.ts" value={draft.globText ?? ''} onChange={(e) => setDraft({...draft,globText:e.target.value})} />
                {draft.globText && <span className={styles.scopePath}>本轮 @路径 或文件附件匹配任一项时生效。含空格的路径写作 <code>@&quot;文件 路径&quot;</code>。</span>}
              </div>
              <div className={styles.fillField}>
                <div className={styles.sectionHeading}>规则正文<button className={styles.modeChip} onClick={() => setPreview(!preview)}>{preview ? '返回编辑' : '预览 Markdown'}</button></div>
                {preview ? <LazyMarkdown enableMermaid={false}>{draft.body}</LazyMarkdown> : <Input.TextArea disabled={saving} spellCheck={false} className={s.source} aria-label="规则内容" data-testid="rule-body-input" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />}
              </div>
            </div>}
          </> : (
            <div className={styles.empty}>{query.trim() ? '没有匹配的规则' : '此范围还没有规则，可点「新建规则」。'}</div>
          )}
        </div>
      </div>
    </>
  );
}
