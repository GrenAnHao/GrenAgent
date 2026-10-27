import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Popconfirm, Tag } from 'antd';
import { Icon } from '@lobehub/ui';
import { ArrowDown, ArrowUp, CheckCircle2, Circle, ListChecks, Play, Plus, X } from 'lucide-react';
import { createStaticStyles, cssVar } from 'antd-style';
import { pi } from '../../lib/pi';
import { pathsEquivalent } from '../../lib/pathUtils';
import { pinRunClock } from '../../stores/agentReducer';
import { agentStoreRegistry, useAgentRegistryStore } from '../../stores/agentStoreRegistry';
import {
  PLAN_STATUS_LABELS,
  isPlanEditable,
  usePlanStore,
  type PlanEntry,
  type PlanSnapshot,
  type PlanStatus,
} from '../../stores/planStore';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: ${cssVar.colorBgContainer};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid ${cssVar.colorBorderSecondary};
    flex-shrink: 0;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  headerTitle: css`
    font-weight: 600;
  `,
  rev: css`
    margin-inline-start: auto;
    color: ${cssVar.colorTextTertiary};
  `,
  body: css`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  steps: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  step: css`
    display: flex;
    align-items: flex-start;
    gap: 6px;
  `,
  stepNo: css`
    flex: none;
    width: 20px;
    padding-block-start: 5px;
    text-align: end;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorTextTertiary};
  `,
  stepActions: css`
    flex: none;
    display: flex;
    gap: 2px;
    padding-block-start: 2px;
  `,
  readTitle: css`
    font-size: var(--pi-font-size, 14px);
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  readGoal: css`
    font-size: var(--pi-font-size-secondary, 13px);
    line-height: 1.6;
    color: ${cssVar.colorTextSecondary};
    white-space: pre-wrap;
  `,
  readStep: css`
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: var(--pi-font-size, 14px);
    line-height: 1.6;
    color: ${cssVar.colorText};
    white-space: pre-wrap;
    word-break: break-word;
  `,
  readStepDone: css`
    color: ${cssVar.colorTextTertiary};
    text-decoration: line-through;
  `,
  readIcon: css`
    flex: none;
    margin-block-start: 4px;
    color: ${cssVar.colorTextQuaternary};
  `,
  readIconDone: css`
    color: ${cssVar.colorSuccess};
  `,
  risks: css`
    margin: 0;
    padding-inline-start: 18px;
    font-size: var(--pi-font-size-secondary, 13px);
    color: ${cssVar.colorTextSecondary};
  `,
  footer: css`
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid ${cssVar.colorBorderSecondary};
    flex-shrink: 0;
  `,
  hint: css`
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  empty: css`
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    text-align: center;
    font-size: 13px;
    line-height: 1.6;
    color: ${cssVar.colorTextTertiary};
  `,
}));

const STATUS_COLORS: Record<PlanStatus, string> = {
  drafting: 'default',
  ready: 'processing',
  confirmed: 'processing',
  executing: 'processing',
  done: 'success',
  cancelled: 'default',
};

interface DraftStep {
  key: number;
  text: string;
  done: boolean;
}

interface Draft {
  title: string;
  goal: string;
  steps: DraftStep[];
  risks: string;
}

let stepKeySeq = 0;

function draftOf(plan: PlanSnapshot): Draft {
  return {
    title: plan.title,
    goal: plan.goal,
    steps: plan.steps.map((s) => ({ key: ++stepKeySeq, text: s.text, done: s.done })),
    risks: plan.risks.join('\n'),
  };
}

function sameDraft(a: Draft, plan: PlanSnapshot): boolean {
  return (
    a.title === plan.title &&
    a.goal === plan.goal &&
    a.risks === plan.risks.join('\n') &&
    a.steps.length === plan.steps.length &&
    a.steps.every((s, i) => s.text === plan.steps[i].text && s.done === plan.steps[i].done)
  );
}

/** 计划的发起会话是否正在跑：跑的时候不能确认执行（扩展也会再拦一次）。 */
function useOwnerRunning(entry: PlanEntry | undefined): boolean {
  const sessionPath = entry?.sessionPath ?? null;
  return useAgentRegistryStore((s) =>
    sessionPath ? s.runningSessionPaths.some((p) => pathsEquivalent(p, sessionPath)) : false,
  );
}

function ReadOnlyPlan({ plan }: { plan: PlanSnapshot }) {
  return (
    <>
      <div className={styles.readTitle} data-testid="plan-read-title">{plan.title}</div>
      {plan.goal ? <div className={styles.readGoal}>{plan.goal}</div> : null}
      <div className={styles.steps}>
        {plan.steps.map((s, i) => (
          <div className={styles.readStep} data-testid="plan-read-step" data-done={s.done ? 'true' : 'false'} key={i}>
            <Icon
              className={`${styles.readIcon} ${s.done ? styles.readIconDone : ''}`}
              icon={s.done ? CheckCircle2 : Circle}
              size={14}
            />
            <span className={s.done ? styles.readStepDone : undefined}>
              {i + 1}. {s.text}
            </span>
          </div>
        ))}
      </div>
      {plan.risks.length > 0 ? (
        <div className={styles.field}>
          风险
          <ul className={styles.risks}>
            {plan.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

/**
 * 右侧「计划」面板：会话里结构化 Plan 的唯一审阅 / 编辑 / 确认入口。
 * 内容和回写目标都取自 planKey 对应的条目（发起会话），不读「当前会话」。
 * 保存走 /plan-update（同一 planId、rev+1），确认走 /plan-confirm（扩展里切 Agent 并开跑）。
 */
export const PlanPanel = memo(function PlanPanel({ planKey }: { planKey: string }) {
  const entry = usePlanStore((s) => s.entries[planKey]);
  const plan = entry?.plan ?? null;
  const running = useOwnerRunning(entry);
  const editable = isPlanEditable(plan);

  const [draft, setDraft] = useState<Draft | null>(() => (plan ? draftOf(plan) : null));
  /** 草稿基于的那一版：判断「有没有改」和「store 里是否已更新」都对它比，不对最新版比。 */
  const [base, setBase] = useState<PlanSnapshot | null>(plan);
  const [pending, setPending] = useState<null | 'save' | 'confirm' | 'cancel' | 'finish'>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dirty = Boolean(base && draft && editable && !sameDraft(draft, base));
  const stale = Boolean(plan && base && (base.id !== plan.id || base.rev !== plan.rev));

  // store 推来新版本：本地没改动、换了一份计划、或正是自己刚保存的，就直接跟上；
  // 否则留着本地修改，显示冲突提示，由用户决定载入最新。
  useEffect(() => {
    if (!plan) {
      setDraft(null);
      setBase(null);
      return;
    }
    if (base && !stale) return;
    if (!base || !draft || base.id !== plan.id || sameDraft(draft, base) || pending === 'save') {
      setDraft(draftOf(plan));
      setBase(plan);
      if (pending === 'save') setPending(null);
    }
  }, [plan, base, stale, draft, pending]);

  // 状态变了（确认 / 取消 / 完成生效）就收掉等待态。
  const status = plan?.status;
  useEffect(() => {
    setPending((p) => (p === 'save' ? p : null));
  }, [status]);

  useEffect(() => () => {
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
  }, []);

  const run = useCallback(
    async (kind: 'save' | 'confirm' | 'cancel' | 'finish', command: string) => {
      if (!entry) return;
      setPending(kind);
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      // 扩展拒绝时只发 notify（toast），这里不会收到新版本：几秒后放开按钮。
      pendingTimer.current = setTimeout(() => setPending(null), 4000);
      try {
        await pi.runCommand(entry.workspace, command, entry.sessionPath);
      } catch {
        setPending(null);
      }
    },
    [entry],
  );

  const reload = useCallback(() => {
    if (!plan) return;
    setDraft(draftOf(plan));
    setBase(plan);
  }, [plan]);

  const patchStep = (key: number, patch: Partial<DraftStep>) =>
    setDraft((d) => (d ? { ...d, steps: d.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)) } : d));
  const moveStep = (index: number, delta: number) =>
    setDraft((d) => {
      if (!d) return d;
      const to = index + delta;
      if (to < 0 || to >= d.steps.length) return d;
      const steps = d.steps.slice();
      const [item] = steps.splice(index, 1);
      steps.splice(to, 0, item);
      return { ...d, steps };
    });
  const removeStep = (key: number) => setDraft((d) => (d ? { ...d, steps: d.steps.filter((s) => s.key !== key) } : d));
  const addStep = () => setDraft((d) => (d ? { ...d, steps: [...d.steps, { key: ++stepKeySeq, text: '', done: false }] } : d));

  const save = () => {
    if (!plan || !draft) return;
    const payload = {
      planId: plan.id,
      rev: base?.rev ?? plan.rev,
      title: draft.title,
      goal: draft.goal,
      // 空行不算步骤：用户加了一行没填，保存时丢掉，不让整次保存失败。
      steps: draft.steps.filter((s) => s.text.trim()).map((s) => ({ text: s.text, done: s.done })),
      risks: draft.risks.split('\n').map((r) => r.trim()).filter(Boolean),
    };
    void run('save', `/plan-update ${JSON.stringify(payload)}`);
  };

  const confirm = () => {
    if (!plan || !entry) return;
    // 确认是一次新请求，但它由扩展发自定义消息开回合：先钉住起点，不接着规划那一轮计时。
    const store = agentStoreRegistry.get(entry.workspace);
    const loaded = store?.getLoadedSessionPath();
    if (store && entry.sessionPath && loaded && pathsEquivalent(loaded, entry.sessionPath)) {
      store.useStore.setState(pinRunClock(store.useStore.getState()));
    }
    void run('confirm', `/plan-confirm ${plan.id} ${plan.rev}`);
  };

  const confirmBlocker = useMemo(() => {
    if (!plan || !editable) return '';
    if (dirty) return '有未保存的修改，先保存再确认执行';
    if (plan.status === 'drafting' || plan.steps.length === 0) return '至少需要一个步骤';
    if (running) return '会话正在运行，等这一轮结束再确认';
    return '';
  }, [plan, editable, dirty, running]);

  if (!plan || !draft) {
    return (
      <div className={styles.root} data-testid="plan-panel">
        <div className={styles.empty} data-testid="plan-panel-empty">
          这个会话还没有计划。切到 Plan 模式描述需求，模型会写出计划并显示在这里。
        </div>
      </div>
    );
  }

  const doneCount = plan.steps.filter((s) => s.done).length;
  const titleEmpty = !draft.title.trim();

  return (
    <div className={styles.root} data-testid="plan-panel" data-plan-id={plan.id} data-status={plan.status}>
      <div className={styles.header}>
        <Icon icon={ListChecks} size={14} />
        <span className={styles.headerTitle}>计划</span>
        <Tag bordered={false} color={STATUS_COLORS[plan.status]} data-testid="plan-status">
          {PLAN_STATUS_LABELS[plan.status]}
        </Tag>
        <span className={styles.rev} data-testid="plan-rev">
          第 {plan.rev} 版{plan.updatedBy === 'user' ? ' · 已手动修改' : ''}
        </span>
      </div>

      <div className={styles.body} data-testid="plan-panel-body">
        {stale && dirty ? (
          <Alert
            data-testid="plan-conflict"
            type="warning"
            showIcon
            message={`计划已更新到第 ${plan.rev} 版，你的修改基于旧版本，保存会被拒绝。`}
            action={
              <Button size="small" onClick={reload} data-testid="plan-reload">
                载入最新
              </Button>
            }
          />
        ) : null}

        {editable ? (
          <>
            <label className={styles.field}>
              标题
              <Input
                aria-label="计划标题"
                data-testid="plan-title-input"
                status={titleEmpty ? 'error' : undefined}
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <label className={styles.field}>
              目标
              <Input.TextArea
                aria-label="计划目标"
                autoSize={{ minRows: 2, maxRows: 8 }}
                data-testid="plan-goal-input"
                value={draft.goal}
                onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
              />
            </label>
            <div className={styles.field}>
              步骤
              <div className={styles.steps}>
                {draft.steps.map((s, i) => (
                  <div className={styles.step} data-index={i} data-testid="plan-step" key={s.key}>
                    <span className={styles.stepNo}>{i + 1}.</span>
                    <Input.TextArea
                      aria-label={`第 ${i + 1} 步`}
                      autoSize={{ minRows: 1, maxRows: 10 }}
                      data-testid="plan-step-input"
                      style={{ flex: 1 }}
                      value={s.text}
                      onChange={(e) => patchStep(s.key, { text: e.target.value })}
                    />
                    <div className={styles.stepActions}>
                      <Button
                        aria-label="上移"
                        data-testid="plan-step-up"
                        disabled={i === 0}
                        icon={<ArrowUp size={14} />}
                        size="small"
                        type="text"
                        onClick={() => moveStep(i, -1)}
                      />
                      <Button
                        aria-label="下移"
                        data-testid="plan-step-down"
                        disabled={i === draft.steps.length - 1}
                        icon={<ArrowDown size={14} />}
                        size="small"
                        type="text"
                        onClick={() => moveStep(i, 1)}
                      />
                      <Button
                        aria-label="删除步骤"
                        data-testid="plan-step-remove"
                        icon={<X size={14} />}
                        size="small"
                        type="text"
                        onClick={() => removeStep(s.key)}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div>
                <Button data-testid="plan-add-step" icon={<Plus size={14} />} size="small" type="dashed" onClick={addStep}>
                  添加步骤
                </Button>
              </div>
            </div>
            <label className={styles.field}>
              风险（每行一条，可留空）
              <Input.TextArea
                aria-label="风险"
                autoSize={{ minRows: 1, maxRows: 6 }}
                data-testid="plan-risks-input"
                value={draft.risks}
                onChange={(e) => setDraft({ ...draft, risks: e.target.value })}
              />
            </label>
          </>
        ) : (
          <ReadOnlyPlan plan={plan} />
        )}
      </div>

      {editable ? (
        <div className={styles.footer}>
          <Popconfirm
            title="取消这份计划？"
            description="取消后不能再确认执行，需要重新规划。"
            okText="取消计划"
            cancelText="保留"
            okButtonProps={{ danger: true, 'data-testid': 'plan-cancel-ok' } as never}
            onConfirm={() => void run('cancel', `/plan-cancel ${plan.id}`)}
          >
            <Button data-testid="plan-cancel" disabled={pending !== null} size="small" type="text">
              取消计划
            </Button>
          </Popconfirm>
          <span className={styles.hint} data-testid="plan-confirm-hint" title={confirmBlocker}>
            {confirmBlocker}
          </span>
          <Button
            data-testid="plan-save"
            disabled={!dirty || titleEmpty || pending !== null}
            loading={pending === 'save'}
            size="small"
            onClick={save}
          >
            保存
          </Button>
          <Button
            data-testid="plan-confirm"
            disabled={Boolean(confirmBlocker) || pending !== null}
            icon={<Play size={14} />}
            loading={pending === 'confirm'}
            size="small"
            type="primary"
            onClick={confirm}
          >
            确认执行
          </Button>
        </div>
      ) : plan.status === 'executing' || plan.status === 'confirmed' ? (
        <div className={styles.footer}>
          <span className={styles.hint} data-testid="plan-progress">
            已完成 {doneCount}/{plan.steps.length}
          </span>
          <Popconfirm
            title="停止跟踪这份计划？"
            description="正在运行的回合不会被中断，只是不再按计划注入剩余步骤。"
            okText="取消计划"
            cancelText="保留"
            onConfirm={() => void run('cancel', `/plan-cancel ${plan.id}`)}
          >
            <Button data-testid="plan-cancel" disabled={pending !== null} size="small" type="text">
              取消
            </Button>
          </Popconfirm>
          <Button
            data-testid="plan-finish"
            disabled={pending !== null}
            loading={pending === 'finish'}
            size="small"
            onClick={() => void run('finish', `/plan-finish ${plan.id}`)}
          >
            标记完成
          </Button>
        </div>
      ) : null}
    </div>
  );
});
