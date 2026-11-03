import { describe, expect, it } from "vitest";
import { catalogModel, resolveUltraRoute, ultraAlias, ultraAllowlist } from "./routing.js";

const available = [
  { provider: "one", id: "model", reasoning: true, contextWindow: 200_000 },
  { provider: "two", id: "org/model:version", reasoning: false, contextWindow: 32_000 },
];
const read = (values: Record<string, string>) => (key: string) => values[key];
const request = { agent: "worker", location: "tasks[1]", parent: { provider: "one", id: "model" }, available };

describe("Ultra route resolution", () => {
  it("resolves each role before the Ultra default, without consuming ordinary values", () => {
    expect(resolveUltraRoute({ ...request, read: read({ SUBAGENT_MODEL: "bad/model", ULTRA_SUBAGENT_MODEL: "one/model", ULTRA_SUBAGENT_MODEL_WORKER: "two/org/model:version" }) }))
      .toEqual({ model: "two/org/model:version", source: "ULTRA_SUBAGENT_MODEL_WORKER" });
  });
  it("falls back to the actual parent and errors deterministically if it is missing", () => {
    expect(resolveUltraRoute({ ...request, read: read({ SUBAGENT_MODEL: "bad/model" }) }).model).toBe("one/model");
    expect(() => resolveUltraRoute({ ...request, parent: undefined, read: read({}) })).toThrow(/tasks\[1\].*worker.*Ultra 模型无法解析/);
  });
  it("supports canonical ids containing slashes and colons through the SDK parser", () => {
    expect(catalogModel("two/org/model:version", available)?.provider).toBe("two");
    expect(catalogModel("org/model:version", available)?.provider).toBe("two");
  });
  it("lets an authorized node override its configured role", () => {
    expect(resolveUltraRoute({ ...request, model: "two/org/model:version", read: read({ ULTRA_SUBAGENT_MODEL_WORKER: "one/model", ULTRA_SUBAGENT_MODEL_ALLOWLIST: '["two/org/model:version"]' }) }).model)
      .toBe("two/org/model:version");
  });
  it("rejects an explicit model authorized only by ordinary settings", () => {
    expect(() => resolveUltraRoute({ ...request, model: "two/org/model:version", read: read({ SUBAGENT_MODEL_ALLOWLIST: '["two/org/model:version"]' }) })).toThrow(/tasks\[1\].*worker.*Ultra.*授权白名单/);
  });
  it("does not fall through a misspelled configured model to a valid parent", () => {
    expect(() => resolveUltraRoute({ ...request, read: read({ ULTRA_SUBAGENT_MODEL_WORKER: "missing/model" }) })).toThrow(/ULTRA_SUBAGENT_MODEL_WORKER.*missing\/model.*不可用/);
  });
  it("resolves Ultra aliases from Ultra roles and never ordinary cheap/strong", () => {
    const config = read({ SUBAGENT_MODEL_CHEAP: "bad/cheap", SUBAGENT_MODEL_STRONG: "bad/strong", ULTRA_SUBAGENT_MODEL_SCOUT: "two/org/model:version", ULTRA_SUBAGENT_MODEL_WORKER: "one/model" });
    expect(ultraAlias("cheap", config)).toBe("two/org/model:version");
    expect(ultraAlias("strong", config)).toBe("one/model");
    expect(ultraAlias("cheap", read({ SUBAGENT_MODEL_CHEAP: "bad/cheap" }))).toBeUndefined();
  });
  it("identifies corrupt authorization configuration rather than opening access", () => {
    expect(() => ultraAllowlist(read({ ULTRA_SUBAGENT_MODEL_ALLOWLIST: "wrong" }))).toThrow("ULTRA_SUBAGENT_MODEL_ALLOWLIST");
    expect(() => ultraAllowlist(read({ ULTRA_SUBAGENT_MODEL_ALLOWLIST: '["one/model",12]' }))).toThrow("JSON 数组");
  });
});
