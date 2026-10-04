import { afterEach, describe, expect, it, vi } from "vitest";
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpTransport, createOAuthFetch, createProviderTokenFetch, establishMcpConnection, remoteRequestInit } from "./transport.js";

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

describe("createProviderTokenFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the provider token on every request and does not send when it is missing", async () => {
    const tokens = ["tok-1", ""];
    const getToken = vi.fn(async () => tokens.shift());
    const baseFetch = vi.fn(async () => new Response("ok"));
    const authFetch = createProviderTokenFetch(getToken, baseFetch);

    await authFetch("https://x/mcp", { method: "POST", headers: { Accept: "application/json" } });
    await expect(authFetch("https://x/mcp", { method: "POST" })).rejects.toThrow("没有供应商登录态");

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    const init = baseFetch.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok-1");
    expect(headers.get("Accept")).toBe("application/json");
  });

  it("installs a fetch that calls the injected getProviderToken on each request", async () => {
    const getProviderToken = vi.fn(async () => "live");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    let installed: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | undefined;
    await establishMcpConnection(
      { name: "vendor", transport: "http", url: "https://x/mcp", auth: { provider: "openai" } },
      { getProviderToken },
      async (transport) => {
        installed = (transport as { _fetch?: typeof installed })._fetch;
        return "connected";
      },
    );
    expect(installed).toEqual(expect.any(Function));
    await installed!("https://x/mcp", { method: "POST" });
    await installed!("https://x/mcp", { method: "POST" });
    expect(getProviderToken).toHaveBeenCalledTimes(2);
    expect(getProviderToken).toHaveBeenCalledWith("openai");
    expect(fetch).toHaveBeenCalledTimes(2);
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
