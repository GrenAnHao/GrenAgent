import { describe, expect, it, vi } from "vitest";
import { onResourceReloadRequested, requestResourceReload } from "./resource-reload.js";

describe("resource reload bus", () => {
  it("notifies and unsubscribes", () => {
    const listener = vi.fn();
    const off = onResourceReloadRequested(listener);
    expect(requestResourceReload()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    off();
    expect(requestResourceReload()).toBe(false);
  });
});
