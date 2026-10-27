import { create } from 'zustand';
import { dockSessionKey } from './dockStore';

/** 与 extensions/agent-mode/plan.ts 的 PlanStatus 一致。 */
export type PlanStatus = 'drafting' | 'ready' | 'confirmed' | 'executing' | 'done' | 'cancelled';

const STATUSES: readonly PlanStatus[] = ['drafting', 'ready', 'confirmed', 'executing', 'done', 'cancelled'];

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  drafting: '草稿',
  ready: '待确认',
  confirmed: '已确认',
  executing: '执行中',
  done: '已完成',
  cancelled: '已取消',
};

export interface PlanStep {
  text: string;
  done: boolean;
}

/** agent-mode 经 setStatus('agent-plan') 推来的结构化计划（源真值在扩展里）。 */
export interface PlanSnapshot {
  id: string;
  title: string;
  goal: string;
  steps: PlanStep[];
  risks: string[];
  status: PlanStatus;
  rev: number;
  updatedAt: number;
  updatedBy: 'model' | 'user';
  file?: string;
}

/** 计划属于发起它的会话。sessionPath 为 null 表示草稿会话。 */
export interface PlanOwner {
  sessionPath: string | null;
  workspace: string;
}

export interface PlanEntry extends PlanOwner {
  plan: PlanSnapshot | null;
}

export type PlanPushReason = 'created' | 'updated' | 'sync';

export function isPlanEditable(plan: PlanSnapshot | null | undefined): boolean {
  return plan?.status === 'drafting' || plan?.status === 'ready';
}

/** 与右坞会话归属同一套 key。 */
export function planKeyOf(owner: PlanOwner): string {
  return dockSessionKey(owner);
}

function asPlan(raw: unknown): PlanSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.id !== 'string' || typeof p.title !== 'string' || !Array.isArray(p.steps)) return null;
  if (!STATUSES.includes(p.status as PlanStatus)) return null;
  return {
    id: p.id,
    title: p.title,
    goal: typeof p.goal === 'string' ? p.goal : '',
    steps: p.steps
      .filter((s): s is { text: string; done?: unknown } => Boolean(s) && typeof (s as { text?: unknown }).text === 'string')
      .map((s) => ({ text: s.text, done: s.done === true })),
    risks: Array.isArray(p.risks) ? p.risks.filter((r): r is string => typeof r === 'string') : [],
    status: p.status as PlanStatus,
    rev: typeof p.rev === 'number' ? p.rev : 1,
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
    updatedBy: p.updatedBy === 'user' ? 'user' : 'model',
    ...(typeof p.file === 'string' ? { file: p.file } : {}),
  };
}

/** 解析 setStatus('agent-plan') 的正文；不是本结构返回 null。plan 为 null 表示会话没有计划。 */
export function parsePlanStatus(text: unknown): { plan: PlanSnapshot | null; reason: PlanPushReason } | null {
  if (typeof text !== 'string') return null;
  try {
    const d = JSON.parse(text) as { plan?: unknown; reason?: unknown };
    if (!d || typeof d !== 'object' || !('plan' in d)) return null;
    const reason: PlanPushReason = d.reason === 'created' || d.reason === 'updated' ? d.reason : 'sync';
    if (d.plan === null) return { plan: null, reason };
    const plan = asPlan(d.plan);
    return plan ? { plan, reason } : null;
  } catch {
    return null;
  }
}

/** 对话流摘要卡正文 `[plan:<id>] …` 里的 planId。 */
export function planIdFromRef(content: string): string | null {
  const m = /^\[plan:([^\]\s]+)\]/.exec(content.trim());
  return m ? m[1] : null;
}

interface PlanState {
  /** key = planKeyOf(owner)。多个会话的计划并存，互不覆盖。 */
  entries: Record<string, PlanEntry>;
  setPlan: (owner: PlanOwner, plan: PlanSnapshot | null) => void;
}

export const usePlanStore = create<PlanState>()((set) => ({
  entries: {},
  setPlan: (owner, plan) =>
    set((s) => {
      const key = planKeyOf(owner);
      return { entries: { ...s.entries, [key]: { sessionPath: owner.sessionPath, workspace: owner.workspace, plan } } };
    }),
}));
