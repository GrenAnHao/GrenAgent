import { describe, expect, it } from "vitest";
import { isLegacyWslBashPath, resolveShellPath } from "./shellPath.js";

const PS51 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const STORE = "C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe";

describe("resolveShellPath", () => {
  it("returns bash on POSIX", async () => {
    expect(await resolveShellPath({ platform: "linux" })).toBe("bash");
    expect(await resolveShellPath({ platform: "darwin" })).toBe("bash");
  });

  it("prefers injected pwsh.exe on win32", async () => {
    const which = (name: string) => (name === "pwsh.exe" ? PWSH : undefined);
    const exists = (path: string) => path === PWSH;
    const statSize = (path: string) => (path === PWSH ? 200000 : 0);
    expect(await resolveShellPath({ platform: "win32", which, exists, statSize })).toBe(PWSH);
  });

  it("falls back to Windows PowerShell 5.1 when pwsh is absent", async () => {
    const which = () => undefined;
    const exists = (path: string) => path === PS51;
    const statSize = (path: string) => (path === PS51 ? 400000 : 0);
    expect(await resolveShellPath({ platform: "win32", which, exists, statSize })).toBe(PS51);
  });

  it("ignores System32 bash.exe even when which returns it", async () => {
    const wsl = "C:\\Windows\\System32\\bash.exe";
    const which = (name: string) => (name === "bash.exe" ? wsl : undefined);
    const exists = (path: string) => path === wsl || path === PS51;
    const statSize = () => 1;
    expect(await resolveShellPath({ platform: "win32", which, exists, statSize })).toBe(PS51);
  });

  it("skips WindowsApps pwsh stubs and uses 5.1", async () => {
    const which = (name: string) => (name === "pwsh.exe" ? STORE : undefined);
    const exists = (path: string) => path === STORE || path === PS51;
    const statSize = (path: string) => (path === STORE ? 0 : 400000);
    expect(await resolveShellPath({ platform: "win32", which, exists, statSize })).toBe(PS51);
  });

  it("returns the 5.1 path string when nothing exists", async () => {
    const which = () => undefined;
    const exists = () => false;
    const statSize = () => 0;
    const resolved = await resolveShellPath({ platform: "win32", which, exists, statSize });
    expect(resolved.replace(/\//g, "\\").toLowerCase()).toMatch(
      /\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/,
    );
  });
});

describe("isLegacyWslBashPath", () => {
  it("detects the Microsoft Bash launcher", () => {
    expect(isLegacyWslBashPath("C:\\Windows\\System32\\bash.exe")).toBe(true);
    expect(isLegacyWslBashPath("C:/Windows/SysWOW64/bash.exe")).toBe(true);
    expect(isLegacyWslBashPath("D:\\Kits\\Git\\bin\\bash.exe")).toBe(false);
  });
});
