import { describe, expect, it } from "vitest";
import { expandServerVars, injectDefaultServers, parseMcpServers, remoteTransportKind, sanitize } from "./config.js";

describe("parseMcpServers", () => {
  it("parses stdio servers (command present)", () => {
    expect(parseMcpServers('{"fs":{"command":"npx","args":["-y","x"],"env":{"K":"v"}}}')).toEqual([
      { name: "fs", transport: "stdio", command: "npx", args: ["-y", "x"], env: { K: "v" } },
    ]);
  });
  it("parses sse servers (url present)", () => {
    expect(parseMcpServers('{"api":{"url":"https://m/sse"}}')).toEqual([
      { name: "api", transport: "sse", url: "https://m/sse" },
    ]);
  });
  it("parses streamable HTTP remote servers and keeps headers", () => {
    expect(parseMcpServers('{"api":{"url":"http://127.0.0.1:54382/mcp","headers":{"x-api-key":"k","Accept":"application/json"}}}')).toEqual([
      { name: "api", transport: "http", url: "http://127.0.0.1:54382/mcp", headers: { "x-api-key": "k", Accept: "application/json" } },
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

describe("injectDefaultServers · legacy filtering", () => {
  it("never injects the legacy codebase-memory server", () => {
    const out = injectDefaultServers([], { PI_PACKAGE_DIR: "/pkg", CODE_INTEL: "codebase-memory" }, "linux");
    expect(out.some((s) => s.name === "codebase-memory")).toBe(false);
  });

  it("drops a stale user-configured codebase-memory server", () => {
    const user = parseMcpServers('{"mcpServers":{"codebase-memory":{"command":"my-cbm"}}}');
    expect(injectDefaultServers(user, {}, "linux")).toEqual([]);
  });

});

describe("sanitize", () => {
  it("replaces non-alphanumeric chars with underscore", () => {
    expect(sanitize("we!rd name")).toBe("we_rd_name");
    expect(sanitize("ok_1")).toBe("ok_1");
  });
});

describe("remoteTransportKind", () => {
  it("treats /sse paths as SSE and other remotes as streamable HTTP", () => {
    expect(remoteTransportKind("http://127.0.0.1:54382/mcp")).toBe("http");
    expect(remoteTransportKind("https://example.com/sse")).toBe("sse");
    expect(remoteTransportKind("https://example.com/v1/sse/")).toBe("sse");
  });
});

describe("expandServerVars", () => {
  it("expands placeholders in remote headers", () => {
    const out = expandServerVars(
      [{ name: "api", transport: "http", url: "http://x/${cwd}", headers: { "X-Root": "${workspaceFolder}/k" } }],
      "/ws",
    );
    expect(out[0]).toMatchObject({ url: "http://x//ws", headers: { "X-Root": "/ws/k" } });
  });

  it("omits a server when a bang command fails and keeps the others", () => {
    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    let out: ReturnType<typeof expandServerVars> | undefined;
    try {
      expect(() => {
        out = expandServerVars(
          [
            { name: "bad", transport: "http", url: "https://example.com", headers: { A: "!node -e process.exit(1)" } },
            { name: "good", transport: "stdio", command: "npx", args: [], env: {} },
          ],
          "/ws",
        );
      }).not.toThrow();
    } finally {
      console.error = error;
    }
    expect(out?.map((server) => server.name)).toEqual(["good"]);
    expect(logged.some((line) => line.includes("bad"))).toBe(true);
  });
});
