import { describe, expect, it } from "vitest";
import { reachesServer, serversToWait } from "./reach";

const resourceTools = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

describe("reachesServer", () => {
  it("matches every server for 'all'", () => {
    expect(reachesServer("all", "docs")).toBe(true);
  });

  it("matches a script word that names the server's tools or namespace", () => {
    // Words of `await tools.mcp__my_docs__search({ q })` as codemode splits them (\w+).
    expect(reachesServer(["await", "tools", "mcp__my_docs__search", "q"], "my-docs")).toBe(true);
    expect(reachesServer(["tools", "mcp__other__search"], "my-docs")).toBe(false);
  });

  it("does not match a bare server name, only the namespace (same as pi built-in MCP)", () => {
    // A variable or comment word equal to the server name, e.g. `const docs = ...`.
    expect(reachesServer(["const", "docs", "await", "fetch"], "docs")).toBe(false);
    expect(reachesServer(["antd"], "antd")).toBe(false);
  });

  it("matches the namespace written with - as _, like pi mcpNamespace", () => {
    expect(reachesServer(["mcp__my_docs"], "my-docs")).toBe(true);
  });

  it("matches tool names that sanitize characters outside [a-zA-Z0-9_]", () => {
    expect(reachesServer(["mcp__a_b__x"], "a.b")).toBe(true);
  });
});

describe("serversToWait", () => {
  const connecting = ["docs", "vendor"];

  it("waits for the servers a reaching tool may reach", () => {
    expect(serversToWait({ toolName: "codemode", reach: ["mcp__docs__search"], connecting, resourceTools })).toEqual(["docs"]);
    expect(serversToWait({ toolName: "tool_search", reach: "all", connecting, resourceTools })).toEqual(connecting);
    expect(serversToWait({ toolName: "codemode", reach: ["bash"], connecting, resourceTools })).toEqual([]);
  });

  it("waits for every connecting server for the resource tools", () => {
    expect(serversToWait({ toolName: "read_mcp_resource", reach: undefined, connecting, resourceTools })).toEqual(connecting);
  });

  it("waits only for its own server for a direct MCP call", () => {
    expect(serversToWait({ toolName: "mcp__vendor__ping", reach: undefined, connecting, resourceTools })).toEqual(["vendor"]);
  });

  it("does not wait for ordinary tools or when nothing is connecting", () => {
    expect(serversToWait({ toolName: "bash", reach: undefined, connecting, resourceTools })).toEqual([]);
    expect(serversToWait({ toolName: "codemode", reach: "all", connecting: [], resourceTools })).toEqual([]);
  });
});
