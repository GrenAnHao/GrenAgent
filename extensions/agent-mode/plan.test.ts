import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allStepsDone,
  createPlan,
  isUnconfirmed,
  makePlanId,
  markDoneFromText,
  planExecutionPrompt,
  planRefContent,
  renderPlanMarkdown,
  revisePlan,
  validatePlanContent,
  withStatus,
  writePlanProjection,
} from "./plan.js";

const LONG_STEP =
  "抽出 requireAuth 中间件到 src/middleware/auth.ts，统一 401/403 的错误体，并让所有 /api 路由经它校验 session；旧的内联校验全部删掉，避免双重校验";

function content(steps: unknown[] = ["抽出中间件", LONG_STEP]) {
  const r = validatePlanContent({ title: "重构鉴权层", goal: "统一错误处理", steps, risks: ["路由遗漏"] });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe("makePlanId", () => {
  it("formats as plan-YYYYMMDD-HHMMSS-rand", () => {
    expect(makePlanId(new Date(2026, 5, 17, 9, 8, 7), "abcd")).toBe("plan-20260617-090807-abcd");
  });
});

describe("validatePlanContent", () => {
  it("keeps every step in full, no truncation", () => {
    const v = content();
    expect(v.steps[1].text).toBe(LONG_STEP);
    expect(LONG_STEP.length).toBeGreaterThan(50);
  });
  it("accepts {text, done} steps from the panel", () => {
    const r = validatePlanContent({ title: "t", goal: "", steps: [{ text: "a", done: true }, "b"] });
    expect(r.ok && r.value.steps).toEqual([{ text: "a", done: true }, { text: "b", done: false }]);
  });
  it("returns readable errors", () => {
    expect(validatePlanContent({ goal: "x", steps: [] })).toEqual({ ok: false, error: expect.stringContaining("title") });
    expect(validatePlanContent({ title: "t", steps: "1. a" })).toEqual({ ok: false, error: expect.stringContaining("steps") });
    expect(validatePlanContent({ title: "t", steps: ["ok", "  "] })).toEqual({ ok: false, error: expect.stringContaining("steps[1]") });
    expect(validatePlanContent(null).ok).toBe(false);
  });
});

describe("create / revise", () => {
  it("creates rev 1; ready when it has steps, drafting when empty", () => {
    expect(createPlan("p1", content(), 1)).toMatchObject({ id: "p1", rev: 1, status: "ready", updatedBy: "model" });
    expect(createPlan("p1", content([]), 1).status).toBe("drafting");
  });
  it("revises under the same id and bumps rev", () => {
    const a = createPlan("p1", content(), 1);
    const b = revisePlan(a, content(["只剩一步"]), 2, "user");
    expect(b).toMatchObject({ id: "p1", rev: 2, updatedBy: "user", updatedAt: 2, createdAt: 1 });
    expect(b.steps).toEqual([{ text: "只剩一步", done: false }]);
    expect(revisePlan(b, content([]), 3, "model").status).toBe("drafting");
  });
  it("model revisions clear done marks; user revisions keep them", () => {
    const a = createPlan("p1", content(), 1);
    const steps = [{ text: "抽出中间件", done: true }, LONG_STEP];
    expect(revisePlan(a, content(steps), 2, "user").steps[0].done).toBe(true);
    expect(revisePlan(a, content(steps), 2, "model").steps[0].done).toBe(false);
  });
  it("only drafting/ready count as unconfirmed", () => {
    const a = createPlan("p1", content(), 1);
    expect(isUnconfirmed(a)).toBe(true);
    expect(isUnconfirmed(withStatus(a, "executing", 2))).toBe(false);
    expect(isUnconfirmed(undefined)).toBe(false);
  });
});

describe("execution", () => {
  it("marks [DONE:n] steps and detects completion", () => {
    const a = withStatus(createPlan("p1", content(), 1), "executing", 1);
    const first = markDoneFromText(a, "做完了 [DONE:1]", 2);
    expect(first.changed).toBe(1);
    expect(allStepsDone(first.plan)).toBe(false);
    expect(markDoneFromText(first.plan, "[DONE:1]", 3).changed).toBe(0);
    expect(allStepsDone(markDoneFromText(first.plan, "[done:2]", 3).plan)).toBe(true);
  });
  it("execution prompt carries every step in full", () => {
    const prompt = planExecutionPrompt(createPlan("p1", content(), 1));
    expect(prompt).toContain(`2. ${LONG_STEP}`);
    expect(prompt).toContain("[DONE:n]");
  });
});

describe("projection", () => {
  it("renders frontmatter + full steps and writes .pi/plans/<id>.md", () => {
    const plan = createPlan("plan-x", content(), Date.UTC(2026, 9, 23));
    const md = renderPlanMarkdown(plan);
    expect(md).toMatch(/^---\nid: plan-x\ntitle: "重构鉴权层"\nstatus: ready\nrev: 1\n/);
    expect(md).toContain(`2. [ ] ${LONG_STEP}`);
    expect(md).toContain("## 风险");
    const dir = mkdtempSync(join(tmpdir(), "plan-"));
    try {
      expect(writePlanProjection(dir, plan)).toBe(".pi/plans/plan-x.md");
      expect(readFileSync(join(dir, ".pi", "plans", "plan-x.md"), "utf8")).toBe(md);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("summary card content starts with the plan tag", () => {
    expect(planRefContent(createPlan("plan-x", content(), 1))).toMatch(/^\[plan:plan-x\] /);
  });
});
