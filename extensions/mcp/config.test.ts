import { describe, expect, it } from "vitest";
import { injectDefaultServers, parseMcpServers, sanitize } from "./config.js";

describe("parseMcpServers", () => {
  it("parses stdio servers (command present)", () => {
    expect(parseMcpServers('{"fs":{"command":"npx","args":["-y","x"],"env":{"K":"v"}}}')).toEqual([
      { name: "fs", transport: "stdio", command: "npx", args: ["-y", "x"], env: { K: "v" } },
    ]);
  });
  it("parses sse servers (url present)", () => {
    expect(parseMcpServers('{"api":{"url":"https://m"}}')).toEqual([
      { name: "api", transport: "sse", url: "https://m" },
    ]);
  });
  it("parses the standard mcpServers wrapper format (.cursor/mcp.json style)", () => {
    expect(parseMcpServers('{"mcpServers":{"fs":{"command":"npx","args":["-y","x"]}}}')).toEqual([
      { name: "fs", transport: "stdio", command: "npx", args: ["-y", "x"], env: {} },
    ]);
  });
  it("tolerates empty / invalid / empty-object JSON", () => {
    expect(parseMcpServers("")).toEqual([]);
    expect(parseMcpServers("not json")).toEqual([]);
    expect(parseMcpServers("{}")).toEqual([]);
  });
  it("skips entries without command or url", () => {
    expect(parseMcpServers('{"bad":{"foo":1}}')).toEqual([]);
  });
  it("parses a stdio server's cwd when present", () => {
    expect(parseMcpServers('{"x":{"command":"c","cwd":"/d"}}')).toEqual([
      { name: "x", transport: "stdio", command: "c", args: [], env: {}, cwd: "/d" },
    ]);
  });
});

describe("injectDefaultServers", () => {
  it("does not inject by default (engines are built into web_search)", () => {
    expect(injectDefaultServers([], {}, "win32")).toEqual([]);
  });
  it("appends open-websearch when OPEN_WEBSEARCH=1 (windows uses cmd /c npx)", () => {
    const out = injectDefaultServers([], { OPEN_WEBSEARCH: "1" }, "win32");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "open-websearch",
      transport: "stdio",
      command: "cmd",
      args: ["/c", "npx", "-y", "open-websearch@latest"],
    });
    expect(out[0].env).toMatchObject({ MODE: "stdio", DEFAULT_SEARCH_ENGINE: "bing" });
  });
  it("uses npx directly on non-windows when enabled", () => {
    expect(injectDefaultServers([], { OPEN_WEBSEARCH: "1" }, "linux")[0]).toMatchObject({
      command: "npx",
      args: ["-y", "open-websearch@latest"],
    });
  });
  it("is disabled when OPEN_WEBSEARCH=0", () => {
    expect(injectDefaultServers([], { OPEN_WEBSEARCH: "0" }, "win32")).toEqual([]);
  });
  it("does not duplicate when the user already configured open-websearch", () => {
    const user = [{ name: "open-websearch", transport: "stdio" as const, command: "x" }];
    expect(injectDefaultServers(user, { OPEN_WEBSEARCH: "1" }, "win32")).toEqual(user);
  });
  it("honors the OPEN_WEBSEARCH_ENGINE override", () => {
    expect(injectDefaultServers([], { OPEN_WEBSEARCH: "1", OPEN_WEBSEARCH_ENGINE: "baidu" }, "linux")[0].env).toMatchObject({
      DEFAULT_SEARCH_ENGINE: "baidu",
    });
  });
});

describe("injectDefaultServers · TencentDB cutover", () => {
  it("never injects the legacy codebase-memory server", () => {
    const out = injectDefaultServers([], { PI_PACKAGE_DIR: "/pkg", CODE_INTEL: "codebase-memory" }, "linux");
    expect(out.some((s) => s.name === "codebase-memory")).toBe(false);
  });

  it("drops a stale user-configured codebase-memory server", () => {
    const user = parseMcpServers('{"mcpServers":{"codebase-memory":{"command":"my-cbm"}}}');
    expect(injectDefaultServers(user, {}, "linux")).toEqual([]);
  });

  it("injects TencentDB knowledge MCP from the bundled runtime", () => {
    const out = injectDefaultServers(
      [],
      {
        PI_PACKAGE_DIR: "C:/app/binaries",
        TDAI_KNOWLEDGE_MCP: "1",
        TDAI_KNOWLEDGE_ENDPOINT: "http://127.0.0.1:8421/v3",
        TDAI_MEMORY_SERVICE_ID: "personal-memory",
        TDAI_CODE_GRAPH_ID: "cg-current",
        TDAI_WIKI_ID: "wiki-current",
        CODE_INTEL: "off",
      },
      "win32",
      {},
      "x64",
      { knowledgeApiToken: "secret", knowledgeUserKey: "user-secret" },
    );
    const server = out.find((s) => s.name === "tencentdb-knowledge");
    expect(server?.command?.replaceAll("\\", "/")).toBe(
      "C:/app/binaries/tencentdb-memory/windows-x86_64/node/node.exe",
    );
    expect(server?.args?.[0]?.replaceAll("\\", "/")).toBe(
      "C:/app/binaries/tencentdb-memory/windows-x86_64/knowledge/bin/mcp.mjs",
    );
    expect(server).toMatchObject({
      name: "tencentdb-knowledge",
      transport: "stdio",
      env: {
        KNOWLEDGE_API_URL: "http://127.0.0.1:8421",
        KNOWLEDGE_API_TOKEN: "secret",
        KNOWLEDGE_USER_KEY: "user-secret",
        KNOWLEDGE_SERVICE_ID: "personal-memory",
        TDAI_CODE_GRAPH_ID: "cg-current",
        TDAI_WIKI_ID: "wiki-current",
      },
    });
  });

  it("does not read the Knowledge token from the general process environment", () => {
    const [server] = injectDefaultServers([], {
      PI_PACKAGE_DIR: "/pkg",
      TDAI_KNOWLEDGE_MCP: "1",
      TDAI_KNOWLEDGE_ENDPOINT: "http://127.0.0.1:8421/v3",
      TDAI_MEMORY_API_KEY: "must-not-forward",
      TDAI_MEMORY_USER_KEY: "must-not-forward-user",
    }, "linux");

    expect(server.env).not.toHaveProperty("KNOWLEDGE_API_TOKEN");
    expect(server.env).not.toHaveProperty("KNOWLEDGE_USER_KEY");
  });

  it("does not inject TencentDB knowledge when the user configured the same name", () => {
    const user = [{ name: "tencentdb-knowledge", transport: "stdio" as const, command: "custom" }];
    const out = injectDefaultServers(user, {
      TDAI_KNOWLEDGE_MCP: "1",
      TDAI_KNOWLEDGE_ENDPOINT: "http://k/v3",
      PI_PACKAGE_DIR: "/pkg",
      CODE_INTEL: "off",
    }, "linux");
    expect(out).toEqual(user);
  });

  it("selects the bundled ARM64 runtime when the sidecar runs on ARM64", () => {
    const out = injectDefaultServers(
      [],
      {
        TDAI_KNOWLEDGE_MCP: "1",
        TDAI_KNOWLEDGE_ENDPOINT: "https://k/v3",
        PI_PACKAGE_DIR: "/pkg",
        CODE_INTEL: "off",
      },
      "darwin",
      {},
      "arm64",
    );
    expect(out.find((s) => s.name === "tencentdb-knowledge")?.command?.replaceAll("\\", "/")).toBe(
      "/pkg/tencentdb-memory/darwin-aarch64/node/bin/node",
    );
  });
});

describe("sanitize", () => {
  it("replaces non-alphanumeric chars with underscore", () => {
    expect(sanitize("we!rd name")).toBe("we_rd_name");
    expect(sanitize("ok_1")).toBe("ok_1");
  });
});
