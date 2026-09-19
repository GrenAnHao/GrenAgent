import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_shared/runtime-config.js", () => ({ getConfig: vi.fn(), watchConfig: vi.fn() }));
vi.mock("./gateway.js", () => ({ startGateway: vi.fn(), postReply: vi.fn() }));

import { __resetImBindingForTest } from "../_shared/im-binding.js";
import { getConfig } from "../_shared/runtime-config.js";
import { type GatewayHandle, postReply, startGateway } from "./gateway.js";
import imgateway from "./index.js";

type AnyFn = (...args: unknown[]) => unknown;

function load(config: Record<string, string | undefined>): Record<string, AnyFn> {
  vi.mocked(getConfig).mockImplementation((k: string) => config[k]);
  const handlers: Record<string, AnyFn> = {};
  const pi = {
    on: (ev: string, h: AnyFn) => {
      handlers[ev] = h;
    },
    registerCommand: () => {},
    sendUserMessage: vi.fn(),
  };
  imgateway(pi as unknown as Parameters<typeof imgateway>[0]);
  return handlers;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.resetAllMocks();
  __resetImBindingForTest();
  (globalThis as { __grenImGateway?: unknown }).__grenImGateway = undefined;
  vi.mocked(startGateway).mockResolvedValue({ port: 8765, close: vi.fn() } as unknown as GatewayHandle);
  vi.mocked(postReply).mockResolvedValue(undefined);
});

describe("im-gateway security hardening (H2)", () => {
  it("forces loopback when enabled without a token on a non-loopback host", async () => {
    const handlers = load({ IM_GATEWAY: "1", IM_GATEWAY_HOST: "0.0.0.0" });
    await handlers.session_start?.({}, { hasUI: false });
    expect(vi.mocked(startGateway).mock.calls[0][0].host).toBe("127.0.0.1");
  });

  it("allows a non-loopback host when a token is set", async () => {
    const handlers = load({ IM_GATEWAY: "1", IM_GATEWAY_HOST: "0.0.0.0", IM_GATEWAY_TOKEN: "s3cret" });
    await handlers.session_start?.({}, { hasUI: false });
    expect(vi.mocked(startGateway).mock.calls[0][0].host).toBe("0.0.0.0");
  });

  it("defaults to loopback when no host is configured", async () => {
    const handlers = load({ IM_GATEWAY: "1" });
    await handlers.session_start?.({}, { hasUI: false });
    expect(vi.mocked(startGateway).mock.calls[0][0].host).toBe("127.0.0.1");
  });
});

describe("im-gateway reply correlation (M4)", () => {
  it("matches replies to requests FIFO across concurrent messages", async () => {
    const handlers = load({ IM_GATEWAY: "1" });
    await handlers.session_start?.({}, { hasUI: false });
    await flush(); // let startGateway resolve so the handle is registered
    const { onMessage } = vi.mocked(startGateway).mock.calls[0][0];
    onMessage({ text: "q1", replyUrl: "http://r1" });
    onMessage({ text: "q2", replyUrl: "http://r2" });
    await handlers.message_end?.({ message: { role: "assistant", content: "a1" } });
    await handlers.message_end?.({ message: { role: "assistant", content: "a2" } });
    expect(vi.mocked(postReply).mock.calls.map((c) => c[0])).toEqual(["http://r1", "http://r2"]);
    expect(vi.mocked(postReply).mock.calls.map((c) => c[1])).toEqual(["a1", "a2"]);
  });

  it("ignores non-assistant messages and posts nothing without a pending reply", async () => {
    const handlers = load({ IM_GATEWAY: "1" });
    await handlers.session_start?.({}, { hasUI: false });
    await flush();
    await handlers.message_end?.({ message: { role: "user", content: "x" } });
    expect(postReply).not.toHaveBeenCalled();
  });
});

describe("ImBinding", () => {
  it("第二 workspace 不重绑网关且通知 owner", async () => {
    const handlers = load({ IM_GATEWAY: "1" });
    await handlers.session_start?.(
      {},
      { hasUI: true, cwd: "D:/a", sessionManager: { getSessionId: () => "s-a" }, ui: { notify: vi.fn() } },
    );
    await flush();
    expect(startGateway).toHaveBeenCalledTimes(1);
    const notify = vi.fn();
    await handlers.session_start?.(
      {},
      { hasUI: true, cwd: "D:/b", sessionManager: { getSessionId: () => "s-b" }, ui: { notify } },
    );
    expect(notify).toHaveBeenCalledWith("IM 已绑定到 D:/a", "warning");
    expect(startGateway).toHaveBeenCalledTimes(1);
    notify.mockClear();
    await handlers.session_start?.(
      {},
      { hasUI: true, cwd: "D:/b", sessionManager: { getSessionId: () => "s-b2" }, ui: { notify } },
    );
    expect(notify).not.toHaveBeenCalled();
  });
});
