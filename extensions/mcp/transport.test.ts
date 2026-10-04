import { afterEach, describe, expect, it, vi } from "vitest";
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpTransport, createOAuthFetch, remoteRequestInit } from "./transport.js";

describe("remoteRequestInit", () => {
  it("passes custom headers into requestInit", () => {
    expect(remoteRequestInit({ "x-api-key": "k" })).toEqual({ requestInit: { headers: { "x-api-key": "k" } } });
  });
  it("drops empty keys", () => {
    expect(remoteRequestInit({ "": "x", Accept: "application/json" })).toEqual({
      requestInit: { headers: { Accept: "application/json" } },
    });
  });
});

describe("createMcpTransport", () => {
  it("uses Streamable HTTP for /mcp and SSE for /sse", () => {
    expect(createMcpTransport({ name: "a", transport: "http", url: "http://127.0.0.1:54382/mcp" })).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(createMcpTransport({ name: "a", transport: "sse", url: "http://127.0.0.1:54382/sse" })).toBeInstanceOf(SSEClientTransport);
  });
});

describe("createOAuthFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges granted scopes into a 403 insufficient_scope WWW-Authenticate header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("", {
          status: 403,
          headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="c"' },
        }),
      ),
    );
    const response = await createOAuthFetch(() => "a b")("https://example.com/mcp");
    expect(extractWWWAuthenticateParams(response).scope).toBe("a b c");
  });
});
