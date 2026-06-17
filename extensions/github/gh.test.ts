import { describe, expect, it } from "vitest";
import { type Exec, runGh } from "./gh.js";

describe("runGh", () => {
  it("returns stdout on success and passes gh + args", async () => {
    const exec: Exec = async (cmd, args) => {
      expect(cmd).toBe("gh");
      expect(args).toEqual(["pr", "view", "1"]);
      return { code: 0, stdout: "ok", stderr: "" };
    };
    expect(await runGh(["pr", "view", "1"], "/tmp", undefined, exec)).toBe("ok");
  });
  it("throws stderr on non-zero exit", async () => {
    const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "not logged in" });
    await expect(runGh(["pr", "view", "1"], "/tmp", undefined, exec)).rejects.toThrow("not logged in");
  });
  it("gives a friendly message when gh is missing (ENOENT)", async () => {
    const exec: Exec = async () => {
      const e = new Error("spawn gh ENOENT") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    };
    await expect(runGh(["pr", "view", "1"], "/tmp", undefined, exec)).rejects.toThrow(/gh CLI/);
  });
});
