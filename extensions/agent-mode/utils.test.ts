import { describe, expect, it } from "vitest";
import { isSafeCommand } from "./utils.js";

describe("isSafeCommand", () => {
  it("still allows POSIX read-only commands", () => {
    expect(isSafeCommand("ls -la")).toBe(true);
    expect(isSafeCommand("git status")).toBe(true);
    expect(isSafeCommand("rm -rf /")).toBe(false);
  });

  it("allows PowerShell read cmdlets", () => {
    expect(isSafeCommand("Get-ChildItem")).toBe(true);
    expect(isSafeCommand("Get-Content .\\a.txt | Select-String \"x\"")).toBe(true);
    expect(isSafeCommand("write-output hi")).toBe(true);
  });

  it("blocks PowerShell write cmdlets and aliases", () => {
    expect(isSafeCommand("Remove-Item .\\a.txt")).toBe(false);
    expect(isSafeCommand("del .\\a.txt")).toBe(false);
    expect(isSafeCommand("Set-Content .\\a.txt -Value x")).toBe(false);
    expect(isSafeCommand("Out-File .\\a.txt")).toBe(false);
    expect(isSafeCommand("copy .\\a.txt .\\b.txt")).toBe(false);
    expect(isSafeCommand("Set-Location ..")).toBe(false);
  });
});
