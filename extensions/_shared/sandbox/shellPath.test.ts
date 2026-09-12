import { describe, expect, it } from "vitest";
import { resolveShellPath } from "./shellPath.js";

describe("resolveShellPath", () => {
  it("returns bash on POSIX", async () => {
    expect(await resolveShellPath({ platform: "linux" })).toBe("bash");
    expect(await resolveShellPath({ platform: "darwin" })).toBe("bash");
  });

  it("uses the injected which on win32", async () => {
    const which = (name: string) => (name === "bash.exe" ? "C:\\Git\\bin\\bash.exe" : undefined);
    expect(await resolveShellPath({ platform: "win32", which })).toBe("C:\\Git\\bin\\bash.exe");
  });
});
