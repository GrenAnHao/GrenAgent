import { describe, expect, it } from "vitest";
import { expandConfigValues, exposureForTool, mergeMcpLayers, normalizeExposure } from "./merge.js";

const stdio = (name: string) => ({ name, transport: "stdio" as const, command: "npx", args: [] as string[], env: {} });

describe("mergeMcpLayers", () => {
  it("lets project mcp.json override the desktop server", () => {
    const merged = mergeMcpLayers({
      desktop: [stdio("fs")],
      global: [],
      project: [{ ...stdio("fs"), command: "node" }],
      globalDisabled: [],
      projectDisabled: [],
      globalAutoEnableCodemode: undefined,
      projectAutoEnableCodemode: undefined,
    });
    expect(merged.servers.find((s) => s.name === "fs")?.command).toBe("node");
  });

  it("drops names listed in disabledMcpServers and enabled:false", () => {
    const merged = mergeMcpLayers({
      desktop: [stdio("a"), { ...stdio("b"), enabled: false }],
      global: [],
      project: [],
      globalDisabled: ["a"],
      projectDisabled: [],
      globalAutoEnableCodemode: undefined,
      projectAutoEnableCodemode: undefined,
    });
    expect(merged.servers.map((s) => s.name)).toEqual([]);
  });

  it("applies a project entry that only sets exposure", () => {
    const merged = mergeMcpLayers({
      desktop: [stdio("fs")],
      global: [],
      project: [{ name: "fs", exposure: "direct" }],
      globalDisabled: [],
      projectDisabled: [],
      globalAutoEnableCodemode: true,
      projectAutoEnableCodemode: false,
    });
    expect(merged.servers[0].exposure).toBe("direct");
    expect(merged.servers[0].command).toBe("npx");
    expect(merged.autoEnableCodemode).toBe(false);
  });

  it("tags each server with its source and drops illegal auth.provider entries", () => {
    const http = (name: string, url: string, sourceAuth = true) => ({
      name,
      transport: "http" as const,
      url,
      ...(sourceAuth ? { auth: { provider: "openai" } } : {}),
    });
    const merged = mergeMcpLayers({
      extension: [http("ext", "https://ext.example/mcp")],
      desktop: [http("desk", "https://desk.example/mcp"), http("loop", "http://127.0.0.1/mcp")],
      global: [http("plain", "http://example.com/mcp"), http("kept", "https://kept.example/mcp")],
      project: [
        http("proj", "https://proj.example/mcp"),
        { name: "kept", exposure: "direct" },
      ],
      globalDisabled: [],
      projectDisabled: [],
      globalAutoEnableCodemode: undefined,
      projectAutoEnableCodemode: undefined,
    });
    expect(merged.servers.map((s) => [s.name, s.source])).toEqual([
      ["ext", "extension"],
      ["desk", "desktop"],
      ["loop", "desktop"],
      ["kept", "global"],
    ]);
    expect(merged.servers.find((s) => s.name === "kept")?.exposure).toBe("direct");
    expect(merged.errors).toEqual([
      "服务器 plain：auth.provider 需要 https，或本机回环上的 http",
      "服务器 proj：项目级 mcp.json 不能使用 auth.provider",
    ]);
  });

  it("records an error when a project override names an unknown server", () => {
    const merged = mergeMcpLayers({
      desktop: [],
      global: [],
      project: [{ name: "missing", exposure: "direct" }],
      globalDisabled: [],
      projectDisabled: [],
      globalAutoEnableCodemode: undefined,
      projectAutoEnableCodemode: undefined,
    });
    expect(merged.servers).toEqual([]);
    expect(merged.errors).toEqual(["项目配置只写了 exposure，但没有名为 missing 的服务器"]);
  });
});

describe("normalizeExposure", () => {
  it("defaults to codemode and accepts the deferred alias", () => {
    expect(normalizeExposure(undefined)).toBe("codemode");
    expect(normalizeExposure("codemode-deferred")).toBe("codemode");
  });
  it("rejects unknown values", () => {
    expect(normalizeExposure("sideways")).toBeUndefined();
  });
});

describe("exposureForTool", () => {
  it("prefers an exact toolExposure name over the first matching pattern", () => {
    expect(exposureForTool("read_file", { exposure: "codemode", toolExposure: { "read_*": "deferred", read_file: "direct" } })).toBe("direct");
    expect(exposureForTool("read_other", { exposure: "codemode", toolExposure: { "write_*": "hidden", "read_*": "deferred" } })).toBe("deferred");
  });
});

describe("expandConfigValues", () => {
  it("expands env vars, home, and a full-value command", () => {
    const expanded = expandConfigValues(
      { command: "npx", args: ["${WORKSPACE}"], env: { T: "${TOKEN}" }, headers: { A: "!node -p process.version" }, cwd: "~/proj" },
      { WORKSPACE: "/ws", TOKEN: "s3cret", home: "/home/u", sessionCwd: "/ws" },
    );
    expect(expanded.args).toEqual(["/ws"]);
    expect(expanded.env).toEqual({ T: "s3cret" });
    expect(expanded.cwd).toBe("/home/u/proj");
    expect(expanded.headers?.A.startsWith("v")).toBe(true);
  });
});
