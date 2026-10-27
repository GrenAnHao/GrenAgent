// Plan 一等工件：结构化 Plan 的类型、参数校验、同 id 修订、执行进度与 .pi/plans/<id>.md 投影。
// 源真值是会话里持久化的结构化 Plan；MD 文件只是投影，读回不以它为准。
// 除 writePlanProjection 外都是纯函数（无 I/O，便于单测）。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * idle（没有 Plan）→ drafting → ready → confirmed → executing → done | cancelled。
 * drafting / ready 是「未确认」：只允许规划工具，手切到全工具模式会被宿主拦下。
 */
export type PlanStatus = "drafting" | "ready" | "confirmed" | "executing" | "done" | "cancelled";

export const PLAN_STATUSES: readonly PlanStatus[] = ["drafting", "ready", "confirmed", "executing", "done", "cancelled"];

export interface PlanStep {
  /** 步骤全文，不截断。 */
  text: string;
  done: boolean;
}

export interface Plan {
  id: string;
  title: string;
  goal: string;
  steps: PlanStep[];
  risks: string[];
  status: PlanStatus;
  /** 每次修订 +1；同一份 Plan 修订不换 id。 */
  rev: number;
  createdAt: number;
  updatedAt: number;
  /** 最后一次修订来自模型（upsert_plan）还是用户（侧栏保存）。 */
  updatedBy: "model" | "user";
  /** MD 投影的相对路径（.pi/plans/<id>.md）；写盘失败时缺省。 */
  file?: string;
}

export interface PlanContent {
  title: string;
  goal: string;
  steps: PlanStep[];
  risks: string[];
}

export const MAX_PLAN_STEPS = 50;
const MAX_TITLE = 200;
const MAX_TEXT = 8000;

export type PlanValidation = { ok: true; value: PlanContent } | { ok: false; error: string };

function asText(v: unknown): string | undefined {
  return typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : undefined;
}

/**
 * 校验并归一化 Plan 内容。steps 接受字符串或 { text, done? }：模型传字符串，侧栏传对象（带完成态）。
 * 失败给出可读原因，调用方原样回给模型 / 用户，不做静默修补。
 */
export function validatePlanContent(raw: unknown): PlanValidation {
  if (!raw || typeof raw !== "object") return { ok: false, error: "参数必须是对象。" };
  const r = raw as Record<string, unknown>;
  const title = asText(r.title);
  if (!title) return { ok: false, error: "title 必填，且不能为空。" };
  if (title.length > MAX_TITLE) return { ok: false, error: `title 过长（${title.length} 字），上限 ${MAX_TITLE}。` };
  const goal = r.goal === undefined ? "" : asText(r.goal);
  if (goal === undefined) return { ok: false, error: "goal 必须是字符串。" };
  if (!Array.isArray(r.steps)) return { ok: false, error: "steps 必须是数组（每项是一个步骤的完整描述）。" };
  if (r.steps.length > MAX_PLAN_STEPS) return { ok: false, error: `steps 最多 ${MAX_PLAN_STEPS} 项，收到 ${r.steps.length} 项。` };
  const steps: PlanStep[] = [];
  for (let i = 0; i < r.steps.length; i++) {
    const s = r.steps[i];
    const text = typeof s === "string" ? asText(s) : s && typeof s === "object" ? asText((s as { text?: unknown }).text) : undefined;
    if (!text) return { ok: false, error: `steps[${i}] 为空或不是字符串。` };
    if (text.length > MAX_TEXT) return { ok: false, error: `steps[${i}] 过长（${text.length} 字），上限 ${MAX_TEXT}。` };
    const done = typeof s === "object" && s !== null && (s as { done?: unknown }).done === true;
    steps.push({ text, done });
  }
  let risks: string[] = [];
  if (r.risks !== undefined) {
    if (!Array.isArray(r.risks)) return { ok: false, error: "risks 必须是字符串数组。" };
    risks = r.risks.map((x) => asText(x)).filter((x): x is string => Boolean(x));
  }
  return { ok: true, value: { title, goal, steps, risks } };
}

export function isUnconfirmed(plan: Plan | undefined): boolean {
  return plan?.status === "drafting" || plan?.status === "ready";
}

/** 还没走到终态（done / cancelled）。 */
export function isPlanOpen(plan: Plan | undefined): boolean {
  return Boolean(plan) && plan!.status !== "done" && plan!.status !== "cancelled";
}

function draftStatus(steps: PlanStep[]): PlanStatus {
  return steps.length > 0 ? "ready" : "drafting";
}

export function createPlan(id: string, content: PlanContent, now: number): Plan {
  return {
    id,
    ...content,
    steps: content.steps.map((s) => ({ text: s.text, done: false })),
    status: draftStatus(content.steps),
    rev: 1,
    createdAt: now,
    updatedAt: now,
    updatedBy: "model",
  };
}

/**
 * 同 id 修订：只允许在未确认阶段改内容；rev +1，状态按步骤是否为空回到 drafting / ready。
 * 规划阶段没有完成态：模型修订时清零，用户在侧栏勾的完成态原样保留（执行前用户可能想标掉已做的）。
 */
export function revisePlan(prev: Plan, content: PlanContent, now: number, by: "model" | "user"): Plan {
  return {
    ...prev,
    ...content,
    steps: content.steps.map((s) => ({ text: s.text, done: by === "user" ? s.done : false })),
    status: draftStatus(content.steps),
    rev: prev.rev + 1,
    updatedAt: now,
    updatedBy: by,
  };
}

export function withStatus(plan: Plan, status: PlanStatus, now: number): Plan {
  return { ...plan, status, updatedAt: now };
}

/** 生成可排序的 plan id：plan-YYYYMMDD-HHMMSS-rand。 */
export function makePlanId(now: Date = new Date(), rand: string = Math.random().toString(36).slice(2, 6)): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `plan-${stamp}-${rand}`;
}

export function extractDoneSteps(message: string): number[] {
  const steps: number[] = [];
  for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

/** 按助手正文里的 [DONE:n]（1 起）标完成；返回新 Plan 与新标掉的步数（0 表示没变）。 */
export function markDoneFromText(plan: Plan, text: string, now: number): { plan: Plan; changed: number } {
  const marks = new Set(extractDoneSteps(text));
  let changed = 0;
  const steps = plan.steps.map((s, i) => {
    if (!s.done && marks.has(i + 1)) {
      changed++;
      return { ...s, done: true };
    }
    return s;
  });
  return changed > 0 ? { plan: { ...plan, steps, updatedAt: now }, changed } : { plan, changed };
}

export function allStepsDone(plan: Plan): boolean {
  return plan.steps.length > 0 && plan.steps.every((s) => s.done);
}

function numbered(steps: PlanStep[], pick: (s: PlanStep) => boolean): string {
  return steps
    .map((s, i) => ({ s, n: i + 1 }))
    .filter(({ s }) => pick(s))
    .map(({ s, n }) => `${n}. ${s.text.replace(/\n/g, "\n   ")}`)
    .join("\n");
}

/** 确认执行时注入的开跑消息：步骤全文，与侧栏一致。 */
export function planExecutionPrompt(plan: Plan): string {
  const lines = [
    `用户已在侧栏确认计划「${plan.title}」（${plan.id}，第 ${plan.rev} 版），现在开始执行。`,
  ];
  if (plan.goal) lines.push("", `目标：${plan.goal}`);
  lines.push("", "步骤：", numbered(plan.steps, () => true));
  const done = plan.steps.filter((s) => s.done).length;
  if (done > 0) lines.push("", `其中已完成的步骤：${plan.steps.map((s, i) => (s.done ? i + 1 : 0)).filter(Boolean).join(", ")}，跳过它们。`);
  lines.push("", "按顺序执行；每完成一步，在回复里写 [DONE:n]（n 为步骤序号）。");
  return lines.join("\n");
}

/** 执行阶段每轮注入的剩余步骤（全文）。 */
export function planRemainingContext(plan: Plan): string {
  return [
    `[EXECUTING PLAN ${plan.id}]`,
    "Remaining steps:",
    numbered(plan.steps, (s) => !s.done),
    "Execute in order; mark each finished step with [DONE:n] in your reply.",
  ].join("\n");
}

/** 规划阶段：用户在侧栏改过计划后，下一轮告诉模型当前版本，避免它按旧版继续改。 */
export function planEditedContext(plan: Plan): string {
  return [
    `[PLAN EDITED BY USER] ${plan.id} rev ${plan.rev}. This is now the current plan; revise from it with upsert_plan (same planId) if needed.`,
    `Title: ${plan.title}`,
    plan.goal ? `Goal: ${plan.goal}` : "",
    "Steps:",
    numbered(plan.steps, () => true),
  ]
    .filter(Boolean)
    .join("\n");
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}

/** MD 投影：frontmatter（id / status / rev / updatedAt）+ 标题、目标、步骤全文、风险。 */
export function renderPlanMarkdown(plan: Plan): string {
  const lines = [
    "---",
    `id: ${plan.id}`,
    `title: ${yamlString(plan.title)}`,
    `status: ${plan.status}`,
    `rev: ${plan.rev}`,
    `updatedAt: ${new Date(plan.updatedAt).toISOString()}`,
    "---",
    "",
    `# ${plan.title}`,
    "",
  ];
  if (plan.goal) lines.push("## 目标", "", plan.goal, "");
  lines.push("## 步骤", "");
  if (plan.steps.length === 0) lines.push("（暂无步骤）");
  plan.steps.forEach((s, i) => lines.push(`${i + 1}. [${s.done ? "x" : " "}] ${s.text.replace(/\n/g, "\n   ")}`));
  lines.push("");
  if (plan.risks.length > 0) {
    lines.push("## 风险", "");
    for (const r of plan.risks) lines.push(`- ${r}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** 写 .pi/plans/<id>.md，返回 POSIX 风格相对路径。 */
export function writePlanProjection(cwd: string, plan: Plan): string {
  const dir = join(cwd, ".pi", "plans");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${plan.id}.md`), renderPlanMarkdown(plan), "utf8");
  return `.pi/plans/${plan.id}.md`;
}

/** 推给前端的快照：reason 说明这次推送的来由（created 时前端自动打开侧栏）。 */
export interface PlanStatusPayload {
  plan: Plan | null;
  reason: "created" | "updated" | "sync";
}

/** 对话流摘要卡的正文：短句给模型看，前端按前缀认出 planId。 */
export function planRefContent(plan: Plan): string {
  return `[plan:${plan.id}] 已生成计划「${plan.title}」，在右侧计划面板审阅、修改并确认执行。`;
}
