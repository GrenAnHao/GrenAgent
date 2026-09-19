import { describe, expect, it } from "vitest";
import headerPlaceholders from "./index.js";

type AnyFn = (...args: unknown[]) => unknown;

function load() {
  const handlers: Record<string, AnyFn> = {};
  const pi = {
    on: (ev: string, h: AnyFn) => {
      handlers[ev] = h;
    },
  };
  headerPlaceholders(pi as unknown as Parameters<typeof headerPlaceholders>[0]);
  return handlers;
}

describe("header-placeholders extension", () => {
  it("在 before_provider_headers 里用当前 sessionId 替换占位符", async () => {
    const handlers = load();
    const headers = { "x-opencode-session": "{sessionId}" };
    await handlers.before_provider_headers?.(
      { type: "before_provider_headers", headers },
      { sessionManager: { getSessionId: () => "ses_local" } },
    );
    expect(headers["x-opencode-session"]).toBe("ses_local");
  });

  it("没有 sessionManager 时不改写", async () => {
    const handlers = load();
    const headers = { "x-opencode-session": "{sessionId}" };
    await handlers.before_provider_headers?.({ type: "before_provider_headers", headers }, {});
    expect(headers["x-opencode-session"]).toBe("{sessionId}");
  });
});
