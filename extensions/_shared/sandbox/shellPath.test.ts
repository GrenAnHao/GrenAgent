import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLegacyWslBashPath, resolveBashShell } from "./shellPath.js";

// 第一次调用要动态加载整个 pi SDK，全量并行跑时会超过默认的 5 秒。
describe("resolveBashShell", { timeout: 30_000 }, () => {
  it("uses the settings shellPath with -c, like pi", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-shellpath-"));
    try {
      const bash = join(dir, "bash.exe");
      writeFileSync(bash, "");
      await expect(resolveBashShell(bash)).resolves.toEqual({ shell: bash, args: ["-c"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails with pi's message when the settings shellPath does not exist", async () => {
    await expect(resolveBashShell(join(tmpdir(), "pi-no-such-dir", "bash.exe"))).rejects.toThrow(/Custom shell path not found/);
  });

  it("never resolves to PowerShell", async () => {
    let shell: string | undefined;
    try {
      shell = (await resolveBashShell()).shell;
    } catch {
      // 没装 bash 的机器：pi 报错，同样不会退回 PowerShell
    }
    if (shell) expect(shell).not.toMatch(/(?:pwsh|powershell)\.exe$/i);
  });
});

describe("isLegacyWslBashPath", () => {
  it("detects the Microsoft Bash launcher", () => {
    expect(isLegacyWslBashPath("C:\\Windows\\System32\\bash.exe")).toBe(true);
    expect(isLegacyWslBashPath("C:/Windows/SysWOW64/bash.exe")).toBe(true);
    expect(isLegacyWslBashPath("D:\\Kits\\Git\\bin\\bash.exe")).toBe(false);
  });
});
