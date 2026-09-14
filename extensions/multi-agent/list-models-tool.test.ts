import { describe, expect, it, vi } from "vitest";
import { registerListSubagentModels } from "./list-models-tool.js";

type Execute = (id: string, params: Record<string, unknown>, s: null, u: null, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function harness(policy: { enabled: boolean; allowlist: Set<string> }) {
  let exec: Execute | undefined;
  const pi = { registerTool: (t: { name: string; execute: Execute }) => { if (t.name === "list_subagent_models") exec = t.execute; } };
  registerListSubagentModels(pi as never, policy);
  return exec;
}

const m = (provider: string, id: string, reasoning = false, name?: string) => ({ provider, id, name: name ?? id, reasoning });
const ctxWith = (models: unknown[]) => ({ cwd: "/p", modelRegistry: { getAvailable: () => models } });

describe("list_subagent_models", () => {
  it("is not registered when policy is disabled", () => {
    expect(harness({ enabled: false, allowlist: new Set(["a/b"]) })).toBeUndefined();
  });

  it("lists allowlist ∩ available with thinking levels", async () => {
    const exec = harness({ enabled: true, allowlist: new Set(["a/b", "a/c", "z/z"]) })!;
    const r = await exec("t", {}, null, null, ctxWith([m("a", "b", true, "B model"), m("a", "c", false), m("q", "q")]));
    const text = r.content[0].text;
    expect(text).toContain("a/b — B model；思考档：off/minimal/low/medium/high/xhigh/max");
    expect(text).toContain("a/c — c；思考档：off");
    expect(text).not.toContain("z/z");
    expect(text).not.toContain("q/q");
  });

  it("filters by provider", async () => {
    const exec = harness({ enabled: true, allowlist: new Set(["a/b", "c/d"]) })!;
    const r = await exec("t", { provider: "c" }, null, null, ctxWith([m("a", "b"), m("c", "d")]));
    expect(r.content[0].text).toContain("c/d");
    expect(r.content[0].text).not.toContain("a/b");
  });

  it("empty intersection is a plain message, not an error", async () => {
    const exec = harness({ enabled: true, allowlist: new Set(["a/b"]) })!;
    const r = await exec("t", {}, null, null, ctxWith([]));
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toBe("白名单内暂无可用模型");
  });

  it("registry failure is treated as empty", async () => {
    const exec = harness({ enabled: true, allowlist: new Set(["a/b"]) })!;
    const r = await exec("t", {}, null, null, { cwd: "/p", modelRegistry: { getAvailable: () => { throw new Error("boom"); } } });
    expect(r.content[0].text).toBe("白名单内暂无可用模型");
  });
});
