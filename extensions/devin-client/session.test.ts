import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Sessions } from "./session.js";

describe("Sessions.view", () => {
  it("reports missing, ok, expired, and revoked without the token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devin-session-"));
    const token = "secret-token-value";
    const sessions = new Sessions({ storePath: join(dir, "session.json") });
    try {
      expect(await sessions.view()).toEqual({ state: "missing" });

      await sessions.store.write({ version: 1, token, expiresAt: Date.now() + 60_000, expirySource: "fallback" });
      const ok = await sessions.view();
      expect(ok.state).toBe("ok");
      expect(ok.expiresAt).toEqual(expect.any(String));
      expect(ok).not.toHaveProperty("token");
      expect(JSON.stringify(ok)).not.toContain(token);

      await sessions.store.write({ version: 1, token, expiresAt: Date.now() - 1_000, expirySource: "jwt" });
      expect((await sessions.view()).state).toBe("expired");

      await sessions.store.write({
        version: 1,
        token,
        expiresAt: Date.now() + 60_000,
        expirySource: "fallback",
        revoked: true,
      });
      expect((await sessions.view()).state).toBe("revoked");
      expect(JSON.stringify(await sessions.view())).not.toContain(token);
    } finally {
      sessions.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
