import { describe, expect, it } from "vitest";
import { waitForDirect } from "./wait.js";

describe("waitForDirect", () => {
  it("resolves when every direct server settles", async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((r) => { release = r; });
    const done = waitForDirect([pending], 1000);
    release();
    await expect(done).resolves.toBe("ready");
  });

  it("resolves with timeout when the budget elapses", async () => {
    await expect(waitForDirect([new Promise(() => {})], 5)).resolves.toBe("timeout");
  });

  it("does not wait when the list is empty", async () => {
    await expect(waitForDirect([], 1000)).resolves.toBe("ready");
  });
});
