import { describe, expect, it } from "vitest";
import {
  authProviderError,
  authorizationIssMatches,
  callbackUrl,
  credentialKey,
  mergeStepUpScope,
  normalizeOAuthTokenFields,
  oauthConfigError,
} from "./oauthRules.js";

describe("callbackUrl", () => {
  it("accepts an http loopback callback without a query", () => {
    expect(callbackUrl("http://127.0.0.1:9/callback")).toBeUndefined();
    expect(callbackUrl("http://localhost/callback")).toBeUndefined();
    expect(callbackUrl("http://[::1]/callback")).toBeUndefined();
  });

  it("returns an error string for a query, a non-loopback host, or a non-http scheme", () => {
    expect(callbackUrl("http://127.0.0.1:9/callback?code=1")).toEqual(expect.any(String));
    expect(callbackUrl("http://127.0.0.1:9/callback?code=1")).not.toBe("");
    expect(callbackUrl("http://example.com/callback")).toEqual(expect.any(String));
    expect(callbackUrl("https://127.0.0.1:9/callback")).toEqual(expect.any(String));
    expect(callbackUrl("http://127.0.0.1:9/callback#frag")).toEqual(expect.any(String));
  });
});

describe("authorizationIssMatches", () => {
  it("is false when both values are present and different", () => {
    expect(authorizationIssMatches("https://auth.example", "https://other.example")).toBe(false);
  });

  it("is true when actual is empty", () => {
    expect(authorizationIssMatches("https://auth.example", "")).toBe(true);
    expect(authorizationIssMatches("https://auth.example", undefined)).toBe(true);
  });

  it("is true when both values are the same", () => {
    expect(authorizationIssMatches("https://auth.example", "https://auth.example")).toBe(true);
  });
});

describe("mergeStepUpScope", () => {
  it("unions scopes and keeps scopes that were already granted", () => {
    expect(mergeStepUpScope("a b", "b c")).toBe("a b c");
  });
});

describe("normalizeOAuthTokenFields", () => {
  it("does not throw when scope is empty and expires_in is null, and drops the empty scope", () => {
    const result = normalizeOAuthTokenFields({ scope: "", expires_in: null, access_token: "tok" });
    expect(result.access_token).toBe("tok");
    expect(result.scope).toBeUndefined();
    expect("scope" in result).toBe(false);
  });
});

describe("oauthConfigError", () => {
  it("rejects cimd registration without clientMetadataUrl", () => {
    expect(oauthConfigError({ clientRegistration: "cimd" })).toEqual(expect.any(String));
    expect(oauthConfigError({ clientRegistration: "cimd" })).not.toBe("");
  });

  it("accepts cimd registration when clientMetadataUrl is set", () => {
    expect(oauthConfigError({
      clientRegistration: "cimd",
      clientMetadataUrl: "https://app.example/oauth/client.json",
    })).toBeUndefined();
  });

  it("does not treat a missing clientName as an error", () => {
    expect(oauthConfigError({})).toBeUndefined();
  });

  it("requires https for authServerMetadataUrl unless the host is loopback", () => {
    expect(oauthConfigError({ authServerMetadataUrl: "http://auth.example/metadata" })).toEqual(expect.any(String));
    expect(oauthConfigError({ authServerMetadataUrl: "https://auth.example/metadata" })).toBeUndefined();
    expect(oauthConfigError({ authServerMetadataUrl: "http://127.0.0.1:9/metadata" })).toBeUndefined();
    expect(oauthConfigError({ authServerMetadataUrl: "http://localhost/metadata" })).toBeUndefined();
    expect(oauthConfigError({ authServerMetadataUrl: "http://[::1]/metadata" })).toBeUndefined();
  });
});

describe("authProviderError", () => {
  it("rejects auth.provider from a project file and from plain http", () => {
    expect(authProviderError({ source: "project", provider: "openai", url: "https://x/mcp" })).toMatch(/项目/);
    expect(authProviderError({ source: "global", provider: "openai", url: "http://example.com/mcp" })).toMatch(/https/);
    expect(authProviderError({ source: "global", provider: "openai", url: "http://127.0.0.1/mcp" })).toBeUndefined();
    expect(authProviderError({ source: "desktop", provider: "openai", url: "https://x/mcp" })).toBeUndefined();
    expect(authProviderError({ source: "global", provider: "openai", url: "http://localhost/mcp" })).toBeUndefined();
    expect(authProviderError({ source: "global", provider: "openai", url: "http://[::1]/mcp" })).toBeUndefined();
    expect(authProviderError({ source: "extension", provider: "openai", url: "https://x/mcp" })).toBeUndefined();
  });
});

describe("credentialKey", () => {
  it("contains the server name and the URL, and differs when the name differs", () => {
    const key = credentialKey("srv", "https://x/mcp");
    expect(key).toContain("srv");
    expect(key).toContain("https://x/mcp");
    expect(credentialKey("left", "https://x/mcp")).not.toBe(credentialKey("right", "https://x/mcp"));
  });
});
