import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function findPwsh(): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const out = execFileSync("where.exe", ["pwsh"], { encoding: "utf8", windowsHide: true });
    return out.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

const pwsh = findPwsh();

// C:\Windows\Temp gives Users add-file but not list. PowerShell 7 Remove-Item
// and cmd del call FindFirstFile on the parent and fail. DeleteFileW still
// works, and so does Windows PowerShell 5.1. Adding synchronize+list makes
// the four paths agree. This recreates that ACL on a private directory.
describe.skipIf(pwsh === undefined)("windows delete without list", () => {
  it("splits until the directory allows FindFirstFile", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-del-"));
    const user = process.env.USERNAME || "";
    const grant = (rights: string) => {
      execFileSync("icacls", [dir, "/grant:r", `${user}:${rights}`], { windowsHide: true });
    };
    try {
      execFileSync("icacls", [dir, "/inheritance:r"], { windowsHide: true });
      grant("(S,WD,AD,X)");
      execFileSync("icacls", [dir, "/grant:r", "CREATOR OWNER:(OI)(CI)(IO)F"], { windowsHide: true });

      const blocked = join(dir, "blocked.txt");
      writeFileSync(blocked, "x");
      expect(removeItem(blocked)).toBe(false);
      expect(existsSync(blocked)).toBe(true);
      expect(cmdDel(join(dir, "cmd.txt"))).toBe(true);
      expect(deleteFile(join(dir, "node.txt"))).toBe(false);
      expect(dotnetDelete(join(dir, "dotnet.txt"))).toBe(false);

      execFileSync("icacls", [dir, "/grant", `${user}:(S,RD,RA)`], { windowsHide: true });
      const file = join(dir, "listed.txt");
      writeFileSync(file, "x");
      expect(removeItem(file)).toBe(true);
      expect(existsSync(file)).toBe(false);
      expect(cmdDel(join(dir, "cmd2.txt"))).toBe(false);
      expect(deleteFile(join(dir, "node2.txt"))).toBe(false);
      expect(dotnetDelete(join(dir, "dotnet2.txt"))).toBe(false);
    } finally {
      grant("(OI)(CI)F");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function removeItem(file: string): boolean {
  writeFileSync(file, "x");
  try {
    execFileSync(pwsh as string, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Remove-Item -LiteralPath '${file.replace(/'/g, "''")}' -Force -ErrorAction Stop`,
    ], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function cmdDel(file: string): boolean {
  writeFileSync(file, "x");
  execFileSync("cmd.exe", ["/d", "/c", "del", "/f", "/q", file], { windowsHide: true, stdio: "ignore" });
  return existsSync(file);
}

function deleteFile(file: string): boolean {
  writeFileSync(file, "x");
  try {
    unlinkSync(file);
    return existsSync(file);
  } catch {
    return true;
  }
}

function dotnetDelete(file: string): boolean {
  writeFileSync(file, "x");
  try {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[System.IO.File]::Delete('${file.replace(/'/g, "''")}')`,
    ], { windowsHide: true });
    return existsSync(file);
  } catch {
    return true;
  }
}
