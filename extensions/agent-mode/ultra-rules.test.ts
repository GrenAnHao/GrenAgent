import { describe, expect, it } from "vitest";
import {
  ULTRA_RULES_CONTEXT_PATH,
  ULTRA_SCHEDULING_RULES,
  applyUltraRules,
  isSubagentSession,
} from "./ultra-rules.js";

const agents = { path: "/AGENTS.md", content: "a" };
const options = (contextFiles: Array<{ path: string; content: string }> = [agents]) => ({ contextFiles });

describe("applyUltraRules", () => {
  it("ultra 主会话追加内置规则，原有 contextFiles 保留", () => {
    const event = options();
    expect(applyUltraRules(event, { mode: "ultra", subagent: false })).toBe(true);
    expect(event.contextFiles).toEqual([
      agents,
      { path: ULTRA_RULES_CONTEXT_PATH, content: ULTRA_SCHEDULING_RULES },
    ]);
  });

  it("非 ultra 模式不追加，也不改已有数组", () => {
    for (const mode of ["agent", "ask", "debug", "plan"] as const) {
      const event = options();
      expect(applyUltraRules(event, { mode, subagent: false })).toBe(false);
      expect(event.contextFiles).toEqual([agents]);
    }
  });

  it("从 ultra 切出后移除同路径的旧规则（复用同一 event 对象也不残留）", () => {
    const event = options();
    applyUltraRules(event, { mode: "ultra", subagent: false });
    expect(event.contextFiles.some((file) => file.path === ULTRA_RULES_CONTEXT_PATH)).toBe(true);

    expect(applyUltraRules(event, { mode: "agent", subagent: false })).toBe(true);
    expect(event.contextFiles).toEqual([agents]);

    // 再切回 ultra 只追加一份
    applyUltraRules(event, { mode: "ultra", subagent: false });
    applyUltraRules(event, { mode: "ultra", subagent: false });
    expect(event.contextFiles.filter((file) => file.path === ULTRA_RULES_CONTEXT_PATH)).toHaveLength(1);
  });

  it("没有 contextFiles 时也能追加", () => {
    const event: { contextFiles?: Array<{ path: string; content: string }> } = {};
    expect(applyUltraRules(event, { mode: "ultra", subagent: false })).toBe(true);
    expect(event.contextFiles?.map((file) => file.path)).toEqual([ULTRA_RULES_CONTEXT_PATH]);
  });

  it("子代理会话不注入，即使模式是 ultra", () => {
    const event = options();
    expect(applyUltraRules(event, { mode: "ultra", subagent: true })).toBe(false);
    expect(event.contextFiles).toEqual([agents]);
  });
});

describe("ULTRA_SCHEDULING_RULES", () => {
  it("写明按需派工、简单任务自己做、并行与文件冲突约束、权限不扩张、运行时决定配置", () => {
    expect(ULTRA_SCHEDULING_RULES).toMatch(/spawn_agent/);
    expect(ULTRA_SCHEDULING_RULES).toMatch(/list_subagent_models/);
    expect(ULTRA_SCHEDULING_RULES).toMatch(/simple/i);    expect(ULTRA_SCHEDULING_RULES).toMatch(/parallel/i);
    expect(ULTRA_SCHEDULING_RULES).toMatch(/same file|shared file/i);
    expect(ULTRA_SCHEDULING_RULES).toMatch(/permission/i);
    expect(ULTRA_SCHEDULING_RULES).toMatch(/profile/i);
    expect(ULTRA_SCHEDULING_RULES).toMatch(/runtime/i);
    expect(ULTRA_SCHEDULING_RULES).toMatch(/orchestrat/i);
  });

  it("不写死供应商 / 模型 / 顾问名额", () => {
    expect(ULTRA_SCHEDULING_RULES).not.toMatch(/opus|sonnet|haiku|claude|gpt|gemini|kimi|deepseek|qwen/i);
    expect(ULTRA_SCHEDULING_RULES).not.toMatch(/advisor quota|one advisor|always delegate|must spawn/i);
  });

  it("角色权限 profile 不同的任务要分开 spawn_agent 调用", () => {
    expect(ULTRA_SCHEDULING_RULES).toMatch(/tasks[\s\S]*chain|chain[\s\S]*tasks/i);
    expect(ULTRA_SCHEDULING_RULES).toMatch(/separate|separately/i);
  });
});

describe("isSubagentSession", () => {
  const base = { entries: [] as Array<{ type?: string; customType?: string }>, origin: "main" as const, env: {} };

  it("主会话返回 false", () => {
    expect(isSubagentSession(base)).toBe(false);
  });

  it("会话里有 subagent_meta 即子代理", () => {
    expect(isSubagentSession({ ...base, entries: [{ type: "custom", customType: "subagent_meta" }] })).toBe(true);
  });

  it("PI_IS_SUBAGENT=1 即子代理", () => {
    expect(isSubagentSession({ ...base, env: { PI_IS_SUBAGENT: "1" } })).toBe(true);
  });

  it("ALS origin=subagent 即子代理；goal 不算", () => {
    expect(isSubagentSession({ ...base, origin: "subagent" })).toBe(true);
    expect(isSubagentSession({ ...base, origin: "goal" })).toBe(false);
  });
});
