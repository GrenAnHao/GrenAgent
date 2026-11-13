import { useEffect, useState } from 'react';
import { Button, Input, Select } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { pi } from '../../lib/pi';
import { BUDGET_FIELDS, type ModelBudgetState, type ModelCompactionPatch, type BudgetField } from '../../../../extensions/_shared/model-compaction-budgets';

const styles = createStaticStyles(({ css }) => ({
  root: css`min-width:0;color:${cssVar.colorText};`,
  help: css`font-size:13px;line-height:1.7;color:${cssVar.colorTextDescription};margin-block:8px 20px;`,
  fields: css`display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:20px;margin-block:20px;`,
  field: css`display:flex;flex-direction:column;gap:8px;min-width:0;`,
  error: css`font-size:13px;line-height:1.6;color:${cssVar.colorError};overflow-wrap:anywhere;`,
  actions: css`display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-block:20px;`,
}));
const names: Record<BudgetField, string> = { reserveTokens: '触发预留余量', keepRecentTokens: '近期保留量' };
const sources = { model: 'Pi 模型覆盖', ordinary: 'Pi 普通设置', default: 'SDK 默认值' };

export function ModelCompactionBudgetsSettings() {
  const [state, setState] = useState<ModelBudgetState>();
  const [selected, setSelected] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, Partial<Record<BudgetField, string>>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const load = async () => { try { setState(await pi.getModelCompactionBudgets()); setError(undefined); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } };
  useEffect(() => { void load(); }, []);
  const row = state?.rows.find((row) => row.key === selected) ?? state?.rows[0];
  const draft = row ? drafts[row.key] ?? {} : {};
  const patch: ModelCompactionPatch = {};
  let invalid = false;
  for (const field of BUDGET_FIELDS) if (Object.hasOwn(draft, field)) {
    const text = draft[field]!.trim();
    const value = text === '' ? null : Number(text);
    if (value !== null && (!/^\d+$/.test(text) || !Number.isSafeInteger(value))) invalid = true;
    if (value !== (row?.desktop[field] ?? null)) patch[field] = value;
  }
  const dirty = Object.keys(patch).length > 0;
  const changed = (field: BudgetField, text: string) => {
    if (!row) return;
    setDrafts((previous) => ({ ...previous, [row.key]: { ...previous[row.key], [field]: text } }));
    setSaved(false); setError(undefined);
  };
  const commit = async (clear = false) => {
    if (!row || invalid) return;
    setBusy(true); setError(undefined);
    try {
      const next = clear ? await pi.clearModelCompactionBudget(row.key) : await pi.patchModelCompactionBudget(row.provider!, row.modelId!, patch);
      setState(next); setDrafts((previous) => { const copy = { ...previous }; delete copy[row.key]; return copy; }); setSaved(true);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const failed = state?.sync.sessions.filter((session) => session.error) ?? [];
  return <section className={styles.root} data-testid="model-compaction-budgets">
    <h2 style={{ marginTop: 0 }}>模型压缩预算</h2>
    <p className={styles.help}>桌面覆盖按精确的供应商 / 模型身份保存。留空继承 Pi；0 是显式预算。Pi 原 settings.json 中的模型覆盖只读，下面展示应用级 SDK 继承值；活会话仍按各自项目的可信设置解析，保存回执显示其实际有效值。</p>
    {state ? <Select data-testid="budget-model" showSearch virtual={false} optionFilterProp="label" style={{ width: '100%' }} value={row?.key} options={state.rows.map((row) => ({ value: row.key, label: `${row.name ? `${row.name} · ` : ''}${row.key}${row.matched ? '' : ' · 未匹配模型'}` }))} onChange={setSelected} /> : !error ? <p>加载中…</p> : null}
    {state && !state.rows.length ? <p>暂无模型。先在供应商设置中添加模型。</p> : null}
    {row ? <>
      {!row.matched ? <p className={styles.help}>此记录未匹配当前模型目录，继续保留；预留 {row.desktop.reserveTokens ?? '继承'} / 近期保留 {row.desktop.keepRecentTokens ?? '继承'} tokens。可显式清除，不按路径拆分或猜测模型身份。</p> : <div className={styles.fields}>
        {BUDGET_FIELDS.map((field) => <label className={styles.field} key={field}>
          <strong>{names[field]}（tokens）</strong>
          <span className={styles.help} style={{ margin: 0 }}>{field === 'reserveTokens' ? 'SDK 自动压缩前保留的上下文余量，不是摘要输出上限。' : '压缩后尽量保留的近期上下文量，不改变最大输出。'}</span>
          <Input data-testid={`budget-${field}`} value={draft[field] ?? (row.desktop[field] === undefined ? '' : String(row.desktop[field]))} placeholder={`继承：${row.inherited?.[field] ?? '未知'}`} onChange={(event) => changed(field, event.target.value)} status={invalid && Object.hasOwn(draft, field) ? 'error' : undefined} />
          <span>桌面：{row.desktop[field] === undefined ? '继承' : row.desktop[field]}</span>
          <span>{row.sources ? sources[row.sources[field]] : '未解析'}：{row.inherited?.[field] ?? '未知'}</span>
          <strong data-testid={`budget-effective-${field}`}>已保存有效值：{row.effective?.[field] ?? '尚未解析'}</strong>
        </label>)}
      </div>}
      {invalid ? <div role="alert" className={styles.error}>预算必须是非负安全整数；留空清除覆盖。</div> : null}
      {row.contextWindow && (Number(draft.reserveTokens ?? row.effective?.reserveTokens) >= row.contextWindow || Number(draft.keepRecentTokens ?? row.effective?.keepRecentTokens) > row.contextWindow) ? <p className={styles.help}>预算达到或超过上下文窗口，可能立即触发压缩或无法保留预期内容；不会自动裁剪数值。</p> : null}
      <div className={styles.actions}>
        {row.matched ? <Button type="primary" data-testid="budget-save" loading={busy} disabled={!dirty || invalid} onClick={() => void commit()}>保存预算</Button> : null}
        <Button data-testid="budget-clear" disabled={busy || !Object.keys(row.desktop).length} onClick={() => void commit(true)}>整模型恢复继承</Button>
        {saved ? <span data-testid="budget-saved">已保存；新请求 / 后续压缩使用新预算，进行中的压缩保持原快照。</span> : null}
      </div>
    </> : null}
    {failed.length ? <div className={styles.error} data-testid="budget-sync-failed">已保存，但部分会话尚未同步：{failed.map((session) => `${session.workspace}${session.sessionPath ? `（${session.sessionPath}）` : ''}：${session.error}`).join('；')}
      <Button data-testid="budget-sync-retry" loading={busy} onClick={async () => { setBusy(true); try { const sync = await pi.syncModelCompactionBudgets(); setState((current) => current ? { ...current, sync } : current); } catch (error) { setError(String(error)); } finally { setBusy(false); } }}>仅重试同步</Button>
    </div> : null}
    {state?.sync.sessions.filter((session) => !session.error && session.effective).map((session) => <p key={`${session.workspace}/${session.sessionPath ?? ''}`} className={styles.help}>会话 {session.workspace} · {session.provider}/{session.modelId}：预留 {session.effective!.reserveTokens} / 近期保留 {session.effective!.keepRecentTokens} tokens</p>)}
    {error ? <div role="alert" className={styles.error}>{error}{!state ? <Button onClick={() => void load()}>重试读取</Button> : null}</div> : null}
    {state?.error ? <div role="alert" className={styles.error}>{state.error}<Button onClick={() => void load()}>重试读取</Button></div> : null}
    <p className={styles.help}>现有全局 / 会话百分比阈值与 SDK token 余量是两个独立条件；都启用时先达到者可触发压缩，修改预算不会改写百分比或开启已关闭的自动路径。</p>
  </section>;
}
