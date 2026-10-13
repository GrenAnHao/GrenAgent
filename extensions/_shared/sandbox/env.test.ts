import { describe, expect, it } from "vitest";
import { filterSecretEnv, withGitSafeDirectory } from "./env.js";

describe("filterSecretEnv", () => {
  it("drops variables whose name looks like a credential", () => {
    const result = filterSecretEnv({
      GH_TOKEN: "t",
      OPENAI_API_KEY: "k",
      AWS_SECRET_ACCESS_KEY: "s",
      DB_PASSWORD: "p",
      SSH_PRIVATE_KEY: "x",
      PATH: "C:\\Windows",
    });
    expect(result).toEqual({ PATH: "C:\\Windows" });
  });

  it("matches credential names regardless of case", () => {
    expect(filterSecretEnv({ gh_token: "t", Api_Key: "k", HOME: "h" })).toEqual({ HOME: "h" });
  });

  it("keeps the allow-listed Pi internal variables even though the names contain TOKEN", () => {
    const result = filterSecretEnv({ PI_HUMAN_ORIGIN_TOKEN: "1", PI_SANDBOX_CWD_GUARD: "g", GH_TOKEN: "t" });
    expect(result).toEqual({ PI_HUMAN_ORIGIN_TOKEN: "1", PI_SANDBOX_CWD_GUARD: "g" });
  });

  it("matches the allow list regardless of case", () => {
    expect(filterSecretEnv({ pi_human_origin_token: "1" })).toEqual({ pi_human_origin_token: "1" });
  });

  it("does not let a PI_ prefix bypass the credential filter", () => {
    expect(filterSecretEnv({ PI_OPENAI_API_KEY: "k", PI_GH_TOKEN: "t", PI_MODE: "x" })).toEqual({ PI_MODE: "x" });
  });

  it("returns a new object and leaves the input untouched", () => {
    const input = { GH_TOKEN: "t", KEEP: "1" };
    const result = filterSecretEnv(input);
    expect(result).not.toBe(input);
    expect(input).toEqual({ GH_TOKEN: "t", KEEP: "1" });
  });

  it("skips undefined values", () => {
    expect(filterSecretEnv({ A: undefined, B: "1" })).toEqual({ B: "1" });
  });
});

describe("withGitSafeDirectory", () => {
  it("trusts the workspace and the repositories under it through git's env-based config", () => {
    const env = withGitSafeDirectory({ KEEP: "1" }, "D:/work/repo");
    expect(env).toMatchObject({
      KEEP: "1",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "D:/work/repo",
      GIT_CONFIG_KEY_1: "safe.directory",
      GIT_CONFIG_VALUE_1: "D:/work/repo/*",
    });
  });

  it("writes the path the way git compares it: forward slashes, no trailing slash", () => {
    const env = withGitSafeDirectory({}, "D:\\work\\repo\\");
    expect(env.GIT_CONFIG_VALUE_0).toBe("D:/work/repo");
    expect(env.GIT_CONFIG_VALUE_1).toBe("D:/work/repo/*");
  });

  it("appends after config the caller already passed instead of replacing it", () => {
    const env = withGitSafeDirectory(
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false" },
      "D:/work/repo",
    );
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_0).toBe("core.autocrlf");
    expect(env.GIT_CONFIG_VALUE_0).toBe("false");
    expect(env.GIT_CONFIG_KEY_1).toBe("safe.directory");
    expect(env.GIT_CONFIG_VALUE_1).toBe("D:/work/repo");
    expect(env.GIT_CONFIG_KEY_2).toBe("safe.directory");
  });

  it("starts from zero when the existing count is not a number", () => {
    expect(withGitSafeDirectory({ GIT_CONFIG_COUNT: "abc" }, "D:/w").GIT_CONFIG_COUNT).toBe("2");
    expect(withGitSafeDirectory({ GIT_CONFIG_COUNT: "-3" }, "D:/w").GIT_CONFIG_COUNT).toBe("2");
  });

  it("does not mutate its input", () => {
    const input = { GIT_CONFIG_COUNT: "1" };
    withGitSafeDirectory(input, "D:/w");
    expect(input).toEqual({ GIT_CONFIG_COUNT: "1" });
  });
});
