import { describe, expect, it } from "vitest";
import { filterSecretEnv } from "./env.js";

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
