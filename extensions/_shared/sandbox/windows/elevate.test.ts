import { describe, expect, it } from "vitest";
import {
  ELEVATED_DONE,
  ELEVATED_PRELUDE,
  elevationFailure,
  elevationLauncher,
  encodePowerShell,
  parseElevationResult,
  psHasAce,
  psQuote,
  windowsPowerShellEnv,
  windowsPowerShellPath,
} from "./elevate.js";

const SHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function payloadOf(launcher: string): string {
  const match = /'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(launcher);
  if (!match) throw new Error("no encoded payload");
  return Buffer.from(match[1], "base64").toString("utf16le");
}

describe("elevation without files", () => {
  it("encodes a script the way -EncodedCommand expects (UTF-16LE base64)", () => {
    const script = "exit 3 # 沙箱";
    expect(Buffer.from(encodePowerShell(script), "base64").toString("utf16le")).toBe(script);
  });

  it("uses Windows PowerShell by absolute path, never a PATH lookup", () => {
    expect(windowsPowerShellPath("C:\\Windows")).toBe(SHELL);
  });

  it("passes the elevated script inline and reads its exit code back", () => {
    const launcher = elevationLauncher("exit 1", SHELL);
    expect(launcher).toContain(`-FilePath ${psQuote(SHELL)}`);
    expect(launcher).toContain("-Verb RunAs");
    // Without caching the handle, Start-Process -Verb RunAs reports a null exit code.
    expect(launcher).toContain("$null = $p.Handle");
    expect(launcher).not.toMatch(/-File\b|\.ps1|\.log|tmp|Temp/i);
  });

  it("pins the module path before the script runs, so a module in the user's Documents is never loaded elevated", () => {
    const payload = payloadOf(elevationLauncher("exit 1", SHELL));
    expect(payload.startsWith(`${ELEVATED_PRELUDE}\n`)).toBe(true);
    expect(ELEVATED_PRELUDE).toBe('$env:PSModulePath = "$PSHOME\\Modules"');
    expect(payload.endsWith("exit 1")).toBe(true);
  });

  it("reports cancel only for a declined UAC prompt, and any other launch failure as an error", () => {
    const launcher = elevationLauncher("exit 1", SHELL);
    expect(launcher).toContain("$e.NativeErrorCode -eq 1223");
    expect(launcher).toContain("[Console]::Error.Write($_.Exception.Message)");
    expect(launcher).toContain("exit 1");
  });

  it("returns the payload bits only when the exit code carries the done marker", () => {
    expect(parseElevationResult(`PI-ELEVATE-EXIT ${ELEVATED_DONE | 5}`)).toBe(5);
    expect(parseElevationResult(`noise\r\nPI-ELEVATE-EXIT ${ELEVATED_DONE}\r\n`)).toBe(0);
  });

  it("never takes a crash, a kill or a script error for a finished script", () => {
    for (const code of [
      0xc000013a | 0, // STATUS_CONTROL_C_EXIT
      0xc0000001 | 0, // STATUS_UNSUCCESSFUL
      0xe0434352 | 0, // unhandled CLR exception
      -1,
      0x40010004, // DBG_TERMINATE_PROCESS
      1,
      0,
    ]) {
      expect(parseElevationResult(`PI-ELEVATE-EXIT ${code}`)).toBeNull();
    }
  });

  it("treats a cancelled prompt or unreadable output as not done", () => {
    expect(parseElevationResult("PI-ELEVATE-CANCELLED")).toBeNull();
    expect(parseElevationResult("PI-ELEVATE-EXIT ")).toBeNull();
    expect(parseElevationResult("")).toBeNull();
  });

  it("keeps the command line out of failure messages", () => {
    const secret = "QUJDREVGR0hJSktMTU5PUA==";
    const timedOut = elevationFailure({ killed: true, code: null, cmd: `powershell -Command ${secret}` }, "");
    expect(timedOut.message).toMatch(/did not finish in time/);
    expect(timedOut.message).not.toContain(secret);
    const failed = elevationFailure({ killed: false, code: 1, cmd: `powershell -Command ${secret}` }, "The system cannot find the file specified.\r\nmore");
    expect(failed.message).toContain("exit 1");
    expect(failed.message).toContain("The system cannot find the file specified.");
    expect(failed.message).not.toContain(secret);
    expect(failed.message).not.toContain("more");
  });

  it("checks an ACE through .NET by SID with every requested right, not by parsing localized icacls output", () => {
    const check = psHasAce("$t", "$sid", { type: "Deny", mask: 0x10156, inheritable: true });
    expect(check).toContain("GetAccessControl($t)");
    expect(check).toContain("[System.Security.Principal.SecurityIdentifier]");
    expect(check).toContain("$_.IdentityReference -eq $sid");
    expect(check).toContain("$_.AccessControlType -eq 'Deny'");
    expect(check).toContain("([int]$_.FileSystemRights -band 65878) -eq 65878");
    expect(check).toContain("[int]$_.InheritanceFlags -eq 3");
    expect(check).toContain("[int]$_.PropagationFlags -eq 0");
    expect(psHasAce("$t", "$sid", { type: "Allow", mask: 1 })).not.toContain("InheritanceFlags");
  });

  it("doubles every quote PowerShell treats as a single quote, including the typographic ones", () => {
    expect(psQuote("C:\\it's")).toBe("'C:\\it''s'");
    for (const quote of ["\u2018", "\u2019", "\u201a", "\u201b"]) {
      expect(psQuote(`Bob${quote}s`)).toBe(`'Bob${quote}${quote}s'`);
    }
  });

  it("drops a pwsh 7 PSModulePath whatever its case", () => {
    const env = windowsPowerShellEnv({ psmodulepath: "C:/pwsh7/Modules", Path: "C:/x" });
    expect(env).toEqual({ Path: "C:/x" });
  });
});
