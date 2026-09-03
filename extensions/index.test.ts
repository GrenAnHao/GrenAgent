import { describe, expect, it } from "vitest";
import {
  allExtensions,
  approval,
  diagramHint,
  fableBehavior,
  multiAgent,
  namedExtensions,
  manifestExtensions,
  selectAllowedExtensions,
  safety,
  memory,
} from "./index.js";

// allExtensions 是 cli/src/main.ts 编译进 sidecar 二进制的整包扩展（既喂给 RPC 运行时，也喂给
// 子代理的 `--mode json -p` 路径 main(argv, { extensionFactories: allExtensions })）。因为是编译进去
// 而非 discovery，子代理无论带 --no-approve / 继承与否都一定加载它们——这是子代理能力闸成立的地基。
// 本测试钉死该地基：安全相关扩展确实在包内，且 safety 第一（其 tool_call 守卫最先拦截）。
describe("allExtensions bundle (compiled into the sidecar)", () => {
  it("includes the security-critical extensions (safety / approval / multi-agent)", () => {
    expect(allExtensions).toContain(safety);
    expect(allExtensions).toContain(approval);
    expect(allExtensions).toContain(multiAgent);
    expect(allExtensions).toContain(fableBehavior);
  });

  it("loads fable-behavior immediately after diagram-hint in the bundle", () => {
    expect(allExtensions.indexOf(diagramHint)).toBeGreaterThan(-1);
    expect(allExtensions.indexOf(fableBehavior)).toBe(allExtensions.indexOf(diagramHint) + 1);
  });

  it("registers safety first so its tool_call guard intercepts earliest", () => {
    expect(allExtensions[0]).toBe(safety);
  });

  it("every entry is an extension factory function", () => {
    expect(allExtensions.length).toBeGreaterThan(0);
    for (const ext of allExtensions) expect(typeof ext).toBe("function");
  });

  it("registers the local memory extension", () => {
    expect(allExtensions).toContain(memory);
    expect(namedExtensions.map((entry) => entry.name)).toContain("memory");
  });

  it("adapts managed manifests without changing the static factory order", () => {
    expect(manifestExtensions.map((entry) => entry.factory)).toEqual(allExtensions);
    expect(manifestExtensions.map((entry) => entry.name)).toEqual(namedExtensions.map((entry) => entry.name));
    expect(manifestExtensions.find((entry) => entry.name === "goal")?.manifest?.capabilities).toContain("agent");
    expect(manifestExtensions.find((entry) => entry.name === "web-search")?.manifest?.permissions?.network).toBe("full");
    expect(manifestExtensions.find((entry) => entry.name === "mcp")?.manifest?.capabilities).toContain("mcp");
    expect(selectAllowedExtensions(["goal", "mcp"]).map((entry) => entry.name)).toEqual(["goal", "mcp"]);
  });
});
