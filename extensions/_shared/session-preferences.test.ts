import { describe, expect, it } from "vitest";
import {
  SESSION_PREFERENCES_ENTRY,
  SESSION_PREFERENCE_FIELDS,
  readRequestedPreferences,
  emptySessionPreferences,
  mergeSessionPreferences,
  parseSessionPreferences,
  parseSessionPreferencesPatch,
  readSessionPreferences,
  sameSessionPreferences,
} from "./session-preferences.js";

describe("session preferences shape", () => {
  it("empty preferences carry revision 0", () => {
    expect(emptySessionPreferences()).toEqual({ revision: 0 });
  });

  it("parse keeps only valid fields and drops unknown ones", () => {
    expect(
      parseSessionPreferences({
        model: { provider: "anthropic", id: "claude" },
        thinkingLevel: "high",
        mode: "plan",
        approval: "readonly",
        revision: 3,
        extra: "ignored",
      }),
    ).toEqual({
      model: { provider: "anthropic", id: "claude" },
      thinkingLevel: "high",
      mode: "plan",
      approval: "readonly",
      revision: 3,
    });
  });

  it("parse rejects invalid enum values instead of coercing them", () => {
    expect(
      parseSessionPreferences({ mode: "turbo", approval: "nope", thinkingLevel: "", model: { provider: "", id: "x" } }),
    ).toEqual({ revision: 0 });
  });

  it("parse treats non-object input as empty", () => {
    expect(parseSessionPreferences(undefined)).toEqual({ revision: 0 });
    expect(parseSessionPreferences("nope")).toEqual({ revision: 0 });
    expect(parseSessionPreferences([])).toEqual({ revision: 0 });
  });

  it("patch parsing drops revision so callers cannot jump versions", () => {
    expect(parseSessionPreferencesPatch({ thinkingLevel: "low", revision: 99 })).toEqual({ thinkingLevel: "low" });
  });

  it("restores removed Brainstorm snapshots as Agent without changing other preferences", () => {
    expect(parseSessionPreferences({
      mode: "brainstorm", model: { provider: "relay", id: "model" }, thinkingLevel: "high",
      approval: "ask", fastMode: true, revision: 7,
    })).toEqual({
      mode: "agent", model: { provider: "relay", id: "model" }, thinkingLevel: "high",
      approval: "ask", fastMode: true, revision: 7,
    });
    expect(parseSessionPreferencesPatch({ mode: "brainstorm", thinkingLevel: "low" })).toEqual({ thinkingLevel: "low" });
  });

  it("parse preserves an unknown-but-saved thinking level from the SDK list", () => {
    // SDK 的 ThinkingLevel 全集，前端字符串透传时不能按前端子集拦掉。
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(parseSessionPreferences({ thinkingLevel: level }).thinkingLevel).toBe(level);
    }
  });

  it("merge keeps untouched fields and bumps revision once", () => {
    const base = parseSessionPreferences({
      model: { provider: "anthropic", id: "claude" },
      thinkingLevel: "high",
      mode: "plan",
      approval: "ask",
      revision: 4,
    });
    expect(mergeSessionPreferences(base, { thinkingLevel: "low" })).toEqual({
      model: { provider: "anthropic", id: "claude" },
      thinkingLevel: "low",
      mode: "plan",
      approval: "ask",
      revision: 5,
    });
  });

  it("merge without a patch still advances revision (serialized write ack)", () => {
    expect(mergeSessionPreferences(emptySessionPreferences(), {})).toEqual({ revision: 1 });
  });

  it("sameSessionPreferences compares field by field", () => {
    const a = parseSessionPreferences({ thinkingLevel: "low", revision: 1 });
    expect(sameSessionPreferences(a, parseSessionPreferences({ thinkingLevel: "low", revision: 1 }))).toBe(true);
    expect(sameSessionPreferences(a, parseSessionPreferences({ thinkingLevel: "low", revision: 2 }))).toBe(false);
    expect(sameSessionPreferences(a, parseSessionPreferences({ thinkingLevel: "high", revision: 1 }))).toBe(false);
  });
});

describe("Fast is a session preference", () => {
  it("parses true and false, rejects non-booleans", () => {
    expect(SESSION_PREFERENCE_FIELDS).toContain("fastMode");
    for (const fastMode of [true, false]) {
      expect(parseSessionPreferences({ fastMode, revision: 2 })).toEqual({ fastMode, revision: 2 });
      expect(parseSessionPreferencesPatch({ fastMode })).toEqual({ fastMode });
    }
    for (const fastMode of ["true", 1, null]) {
      expect(parseSessionPreferences({ fastMode })).toEqual({ revision: 0 });
    }
  });

  it("turning Fast off preserves the other preferences and advances revision", () => {
    const base = parseSessionPreferences({ fastMode: true, thinkingLevel: "high", mode: "plan", approval: "ask", revision: 4 });
    expect(mergeSessionPreferences(base, { fastMode: false })).toEqual({ fastMode: false, thinkingLevel: "high", mode: "plan", approval: "ask", revision: 5 });
    expect(sameSessionPreferences(base, { ...base, fastMode: false })).toBe(false);
  });

  it("restores false after true and keeps it through a later partial mode entry", () => {
    const entries = [
      { type: "custom", customType: SESSION_PREFERENCES_ENTRY, data: { fastMode: true, thinkingLevel: "high", revision: 1 } },
      { type: "custom", customType: SESSION_PREFERENCES_ENTRY, data: { fastMode: false, revision: 2 } },
      { type: "custom", customType: SESSION_PREFERENCES_ENTRY, data: { mode: "agent", revision: 3 } },
    ];
    expect(readRequestedPreferences(entries)).toEqual({ fastMode: false, thinkingLevel: "high", mode: "agent", revision: 3 });
    expect(readSessionPreferences(entries)).toEqual({ fastMode: false, thinkingLevel: "high", mode: "agent", revision: 3 });
  });
});

describe("readSessionPreferences from session entries", () => {
  const entry = (value: Record<string, unknown>) => value as { type: string; customType?: string; data?: unknown };

  it("reads model and thinking from SDK entries in file order when nothing canonical exists", () => {
    const prefs = readSessionPreferences([
      entry({ type: "model_change", provider: "anthropic", modelId: "a" }),
      entry({ type: "model_change", provider: "openai", modelId: "b" }),
      entry({ type: "thinking_level_change", thinkingLevel: "low" }),
      entry({ type: "thinking_level_change", thinkingLevel: "high" }),
    ]);
    expect(prefs).toEqual({
      model: { provider: "openai", id: "b" },
      thinkingLevel: "high",
      revision: 0,
    });
  });

  it("reads mode/approval from session-controls and agent-mode entries", () => {
    const prefs = readSessionPreferences([
      entry({ type: "custom", customType: "session-controls", data: { mode: "plan", approval: "readonly" } }),
      entry({ type: "custom", customType: "agent-mode", data: { mode: "ask" } }),
    ]);
    expect(prefs).toEqual({ mode: "ask", approval: "readonly", revision: 0 });
  });

  it("canonical entry supplies requested model/thinking and carries revision", () => {
    const prefs = readSessionPreferences([
      entry({ type: "model_change", provider: "anthropic", modelId: "a" }),
      entry({ type: "thinking_level_change", thinkingLevel: "low" }),
      entry({ type: "custom", customType: "session-controls", data: { mode: "plan" } }),
      entry({
        type: "custom",
        customType: SESSION_PREFERENCES_ENTRY,
        data: { model: { provider: "openai", id: "gpt" }, thinkingLevel: "high", mode: "debug", approval: "full", revision: 2 },
      }),
    ]);
    expect(prefs).toEqual({
      model: { provider: "openai", id: "gpt" },
      thinkingLevel: "high",
      mode: "debug",
      approval: "full",
      revision: 2,
    });
  });

  it("SDK clamp artifact（钳制结果的原生 thinking 条目）不改写请求值", () => {
    // 换到非推理模型时 SDK 会追加 thinking_level_change=off。这是 effective 值，
    // 不能改写用户请求的 high（靠 clampThinking 判断它是钳制 artifact）。
    const prefs = readSessionPreferences([
      entry({
        type: "custom",
        customType: SESSION_PREFERENCES_ENTRY,
        data: { model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high", revision: 1 },
      }),
      entry({ type: "model_change", provider: "anthropic", modelId: "plain" }),
      entry({ type: "thinking_level_change", thinkingLevel: "off" }),
    ], { clampThinking: (level) => (level === "high" ? "off" : level) });
    // canonical 之后的原生 model_change 是显式/后续模型选择（setModel 只会为真正的模型切换写它）
    expect(prefs.model).toEqual({ provider: "anthropic", id: "plain" });
    expect(prefs.thinkingLevel).toBe("high");
    expect(prefs.revision).toBe(1);
  });

  it("a later explicit patch (new canonical entry) still replaces the saved request", () => {
    const prefs = readSessionPreferences([
      entry({ type: "custom", customType: SESSION_PREFERENCES_ENTRY, data: { thinkingLevel: "high", revision: 1 } }),
      entry({ type: "thinking_level_change", thinkingLevel: "off" }),
      entry({ type: "custom", customType: SESSION_PREFERENCES_ENTRY, data: { thinkingLevel: "low", revision: 2 } }),
    ]);
    expect(prefs.thinkingLevel).toBe("low");
    expect(prefs.revision).toBe(2);
  });

  it("fields absent from the canonical entry fall back to legacy native entries", () => {
    const prefs = readSessionPreferences([
      entry({ type: "model_change", provider: "anthropic", modelId: "a" }),
      entry({ type: "thinking_level_change", thinkingLevel: "low" }),
      entry({ type: "custom", customType: SESSION_PREFERENCES_ENTRY, data: { mode: "plan", revision: 3 } }),
    ]);
    expect(prefs).toEqual({
      model: { provider: "anthropic", id: "a" },
      thinkingLevel: "low",
      mode: "plan",
      revision: 3,
    });
  });

  it("canonical 之后没有原生条目时，缺字段逐项回退 legacy", () => {
    const prefs = readSessionPreferences([
      entry({ type: "thinking_level_change", thinkingLevel: "low" }),
      entry({ type: "model_change", provider: "anthropic", modelId: "other" }),
      entry({ type: "custom", customType: SESSION_PREFERENCES_ENTRY, data: { model: { provider: "openai", id: "gpt" }, revision: 1 } }),
    ]);
    expect(prefs.model).toEqual({ provider: "openai", id: "gpt" });
    expect(prefs.thinkingLevel).toBe("low");
  });

  it("legacy automatic mode changes after a preferences entry still win (no canonical mode lock)", () => {
    const prefs = readSessionPreferences([
      entry({
        type: "custom",
        customType: SESSION_PREFERENCES_ENTRY,
        data: { mode: "plan", revision: 1 },
      }),
      // Plan 确认之后扩展自己写的新条目
      entry({ type: "custom", customType: "agent-mode", data: { mode: "agent" } }),
    ]);
    expect(prefs).toEqual({ mode: "agent", revision: 1 });
  });

  it("a newer preferences mode beats an older automatic entry", () => {
    const prefs = readSessionPreferences([
      entry({ type: "custom", customType: "agent-mode", data: { mode: "plan" } }),
      entry({ type: "custom", customType: SESSION_PREFERENCES_ENTRY, data: { mode: "brainstorm", revision: 1 } }),
    ]);
    expect(prefs).toEqual({ mode: "agent", revision: 1 });
  });

  it.each(["agent-mode", "session-controls"])("restores the latest removed mode in %s instead of resurrecting Plan", (customType) => {
    const prefs = readSessionPreferences([
      entry({ type: "custom", customType: SESSION_PREFERENCES_ENTRY, data: { mode: "plan", approval: "readonly", thinkingLevel: "high", fastMode: false, revision: 3 } }),
      entry({ type: "custom", customType, data: { mode: "brainstorm" } }),
    ]);
    expect(prefs).toEqual({ mode: "agent", approval: "readonly", thinkingLevel: "high", fastMode: false, revision: 3 });
  });

  it("cold restoration normalizes the last canonical mode without falling back to an older Ask", () => {
    expect(readRequestedPreferences([
      entry({ type: "custom", customType: SESSION_PREFERENCES_ENTRY, data: { mode: "ask", revision: 1 } }),
      entry({ type: "custom", customType: SESSION_PREFERENCES_ENTRY, data: { mode: "brainstorm", approval: "ask", revision: 4 } }),
    ])).toEqual({ mode: "agent", approval: "ask", revision: 4 });
  });

  it("ignores malformed entries rather than resetting everything", () => {
    const prefs = readSessionPreferences([
      entry({ type: "model_change", provider: "anthropic", modelId: "a" }),
      entry({ type: "custom", customType: SESSION_PREFERENCES_ENTRY, data: "garbage" }),
      { type: "custom" },
    ]);
    expect(prefs).toEqual({ model: { provider: "anthropic", id: "a" }, revision: 0 });
  });

  it("returns empty preferences for no entries", () => {
    expect(readSessionPreferences([])).toEqual({ revision: 0 });
  });
});

describe("canonical 之后的显式原生选择（扩展 pi.setModel / 用户切档）", () => {
  const entry = (value: Record<string, unknown>) => value as { type: string; customType?: string; data?: unknown };
  const canonical = entry({
    type: "custom",
    customType: SESSION_PREFERENCES_ENTRY,
    data: { model: { provider: "relay", id: "think" }, thinkingLevel: "high", revision: 1 },
  });

  it("扩展显式切模型（原生 model_change 在 canonical 之后）不被冷恢复回旧模型", () => {
    const prefs = readSessionPreferences([
      canonical,
      entry({ type: "model_change", provider: "relay", modelId: "other" }),
    ]);
    expect(prefs.model).toEqual({ provider: "relay", id: "other" });
  });

  it("钳制产生的 thinking 条目（等于 clamp(high)=off）不算显式选择", () => {
    const prefs = readSessionPreferences(
      [canonical, entry({ type: "thinking_level_change", thinkingLevel: "off" })],
      { clampThinking: (level) => (level === "high" ? "off" : level) },
    );
    expect(prefs.thinkingLevel).toBe("high");
  });

  it("不等于钳制结果的 thinking 条目算显式选择", () => {
    const prefs = readSessionPreferences(
      [canonical, entry({ type: "thinking_level_change", thinkingLevel: "low" })],
      { clampThinking: (level) => (level === "high" ? "off" : level) },
    );
    expect(prefs.thinkingLevel).toBe("low");
  });

  it("没有 clampThinking 时无法区分钳制与显式，保守保留请求值", () => {
    const prefs = readSessionPreferences([canonical, entry({ type: "thinking_level_change", thinkingLevel: "low" })]);
    expect(prefs.thinkingLevel).toBe("high");
  });
});
