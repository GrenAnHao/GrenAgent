import { describe, expect, it } from "vitest";
import { ancestorDirectories, defaultSandboxHome, grantKey, icaclsGrantArgs, isGrantableAncestor, needsGrant, profilePathDirs, sandboxIdentityEnv, windowsTempAllowsList } from "./account.js";

describe("windows sandbox account grants", () => {
  it("builds an inheritable icacls grant and propagates only when asked", () => {
    expect(icaclsGrantArgs("C:/work/repo", "PiSandbox", "M", true)).toEqual([
      "C:/work/repo",
      "/grant:r",
      "PiSandbox:(OI)(CI)M",
      "/C",
      "/T",
    ]);
    expect(icaclsGrantArgs("C:/work/repo", "PiSandbox", "RX", false)).not.toContain("/T");
    expect(icaclsGrantArgs("C:/Users/me/.pi", "PiSandbox", "RAX", true)).toEqual([
      "C:/Users/me/.pi",
      "/grant:r",
      "PiSandbox:(RA,X)",
      "/C",
    ]);
    expect(icaclsGrantArgs("C:/Windows/Temp", "PiSandbox", "RD", true)).toEqual([
      "C:/Windows/Temp",
      "/grant:r",
      "PiSandbox:(S,RD,RA)",
      "/C",
    ]);
  });

  it("points identity and temp at the sandbox profile, not the signed-in user", () => {
    const home = defaultSandboxHome("PiSandbox", "C:");
    const env = sandboxIdentityEnv(home, "PiSandbox");
    expect(env.USERNAME).toBe("PiSandbox");
    expect(env.USERPROFILE).toBe(home);
    expect(env.HOMEDRIVE).toBe("C:");
    expect(env.HOMEPATH).toBe("\\Users\\PiSandbox");
    expect(env.TEMP).toBe(`${home}\\AppData\\Local\\Temp`);
    expect(env.TMP).toBe(env.TEMP);
    expect(env.TMPDIR).toBe(env.TEMP);
    expect(env.APPDATA).toBe(`${home}\\AppData\\Roaming`);
    expect(env.LOCALAPPDATA).toBe(`${home}\\AppData\\Local`);
    expect(env.USERPROFILE).not.toContain("rxstudio");
    expect(env.TEMP).not.toContain("pi-sandbox");
  });

  it("lists ancestor directories and stops before the drive root", () => {
    const dirs = ancestorDirectories("C:/Users/me/.pi/agent/works/session").map(grantKey);
    expect(dirs[0]).toBe(grantKey("C:/Users/me/.pi/agent/works"));
    expect(dirs).toContain(grantKey("C:/Users/me/.pi"));
    expect(dirs).toContain(grantKey("C:/Users/me"));
    expect(dirs.some((dir) => dir === "c:" || dir === "c:/")).toBe(false);
  });

  it("does not grant traverse on the profile root or AppData", () => {
    const home = "C:/Users/me";
    const temp = "C:/Users/me/AppData/Local/Temp/pi-sandbox/session";
    expect(isGrantableAncestor("C:/Users/me/.pi", home, temp)).toBe(true);
    expect(isGrantableAncestor("C:/Users/me/.pi/agent", home, temp)).toBe(true);
    expect(isGrantableAncestor("C:/Users/me/AppData/Local/Temp/pi-sandbox", home, temp)).toBe(true);
    expect(isGrantableAncestor("C:/Users/me", home, temp)).toBe(false);
    expect(isGrantableAncestor("C:/Users/me/AppData", home, temp)).toBe(false);
    expect(isGrantableAncestor("C:/Users/me/AppData/Local", home, temp)).toBe(false);
    expect(isGrantableAncestor("C:/Users", home, temp)).toBe(false);
  });

  it("skips a path whose recorded rights already match", () => {
    const key = grantKey("C:/work/repo");
    expect(needsGrant({ [key]: "M" }, "C:/work/repo/", "M")).toBe(false);
    expect(needsGrant({ [key]: "RX" }, "C:/work/repo", "M")).toBe(true);
    expect(needsGrant({}, "C:/work/repo", "RX")).toBe(true);
  });

  it("selects PATH entries under the user profile only", () => {
    const home = "C:/Users/me";
    expect(profilePathDirs(
      "C:\\Windows\\System32;C:\\Users\\me\\AppData\\Local\\fnm;C:\\Users\\me\\AppData\\Local\\fnm",
      home,
    ).map(grantKey)).toEqual([grantKey("C:/Users/me/AppData/Local/fnm")]);
  });

  it("does not treat a stale RD record as a confirmed Windows Temp list grant", () => {
    const key = grantKey("C:/Windows/Temp");
    expect(needsGrant({ [key]: "RD" }, "C:/Windows/Temp", "RD1")).toBe(true);
    expect(needsGrant({ [key]: "RD1" }, "C:/Windows/Temp", "RD1")).toBe(false);
  });

  it("reads an icacls dump for list rights without treating add-file as list", () => {
    const usersOnly = "C:\\Windows\\Temp BUILTIN\\Users:(CI)(S,WD,AD,X)";
    const granted = "C:\\Windows\\Temp BUILTIN\\Users:(CI)(S,WD,AD,X)\n              HOST\\PiSandbox:(S,RD,RA)";
    expect(windowsTempAllowsList(usersOnly, "PiSandbox")).toBe(false);
    expect(windowsTempAllowsList(granted, "PiSandbox")).toBe(true);
    expect(icaclsGrantArgs("C:/Windows/Temp", "PiSandbox", "RD1", true)).toEqual([
      "C:/Windows/Temp",
      "/grant:r",
      "PiSandbox:(S,RD,RA)",
      "/C",
    ]);
  });
});