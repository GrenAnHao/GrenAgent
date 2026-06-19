import { describe, expect, it } from "vitest";
import { matchProtectedPath } from "./protected-paths.js";

describe("matchProtectedPath", () => {
  it("matches .env / .git / node_modules / keys", () => {
    expect(matchProtectedPath(".env")).toBe(true);
    expect(matchProtectedPath("config/.env.local")).toBe(true);
    expect(matchProtectedPath("repo/.git/config")).toBe(true);
    expect(matchProtectedPath("node_modules/x/y.js")).toBe(true);
    expect(matchProtectedPath("certs/server.pem")).toBe(true);
    expect(matchProtectedPath("id_rsa.key")).toBe(true);
  });
  it("handles windows separators", () => {
    expect(matchProtectedPath("repo\\.git\\config")).toBe(true);
    expect(matchProtectedPath("node_modules\\x\\y.ts")).toBe(true);
  });
  it("allows normal source paths and empty", () => {
    expect(matchProtectedPath("src/app.ts")).toBe(false);
    expect(matchProtectedPath("README.md")).toBe(false);
    expect(matchProtectedPath("envfile.ts")).toBe(false);
    expect(matchProtectedPath("")).toBe(false);
  });
});
