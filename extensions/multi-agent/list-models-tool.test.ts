import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn() }));
import { getConfig } from "../_shared/runtime-config.js";
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
const cfg = (map: Record<string, string | undefined>) => vi.mocked(getConfig).mockImplementation((k: string) => map[k]);

beforeEach(() => {
  vi.resetAllMocks();
  cfg({});
});

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

  it("reads the allowlist on every call, so edits reach already-open sessions", async () => {
    let list = new Set(["a/b"]);
    const policy = { enabled: true, get allowlist() { return list; } };
    const exec = harness(policy)!;
    const models = [m("a", "b", false, "B"), m("c", "d", false, "D")];
    expect((await exec("t", {}, null, null, ctxWith(models))).content[0].text).toContain("a/b");
    list = new Set(["c/d"]);
    const after = (await exec("t", {}, null, null, ctxWith(models))).content[0].text;
    expect(after).toContain("c/d");
    expect(after).not.toContain("a/b");
  });

  describe("cheap / strong aliases", () => {
    const policy = { enabled: true, allowlist: new Set(["c/sonnet"]) };
    const avail = [m("c", "sonnet", true, "Sonnet"), m("deepseek", "flash", true, "DeepSeek Flash")];

    it("lists both aliases with the route they resolve to, even though they are not in the allowlist", async () => {
      cfg({ SUBAGENT_MODEL_CHEAP: "deepseek/flash", SUBAGENT_MODEL_STRONG: "c/sonnet" });
      const text = (await harness(policy)!("t", {}, null, null, ctxWith(avail))).content[0].text;
      expect(text).toContain("cheap → deepseek/flash — DeepSeek Flash");
      expect(text).toContain("strong → c/sonnet — Sonnet");
      expect(text).toContain('model: "cheap"');
      // 白名单里的 Sonnet 本身仍单独列一行
      expect(text.split("\n").some((l) => l.startsWith("c/sonnet — Sonnet"))).toBe(true);
    });

    it("alias rows alone are enough to avoid the empty message", async () => {
      cfg({ SUBAGENT_MODEL_CHEAP: "deepseek/flash" });
      const text = (await harness(policy)!("t", {}, null, null, ctxWith([m("deepseek", "flash", false, "DeepSeek Flash")]))).content[0].text;
      expect(text).toContain("cheap → deepseek/flash");
      expect(text).not.toBe("白名单内暂无可用模型");
    });

    it("marks an alias whose target is not in the catalog", async () => {
      cfg({ SUBAGENT_MODEL_CHEAP: "gone/model" });
      const text = (await harness(policy)!("t", {}, null, null, ctxWith(avail))).content[0].text;
      expect(text).toContain("cheap → gone/model — 当前不可用");
    });

    it("provider filter applies to the resolved route", async () => {
      cfg({ SUBAGENT_MODEL_CHEAP: "deepseek/flash", SUBAGENT_MODEL_STRONG: "c/sonnet" });
      const text = (await harness(policy)!("t", { provider: "deepseek" }, null, null, ctxWith(avail))).content[0].text;
      expect(text).toContain("cheap →");
      expect(text).not.toContain("strong →");
    });

    it("omits aliases that resolve to nothing", async () => {
      const text = (await harness(policy)!("t", {}, null, null, ctxWith(avail))).content[0].text;
      expect(text).not.toContain("cheap →");
      expect(text).not.toContain("strong →");
    });
  });
});
