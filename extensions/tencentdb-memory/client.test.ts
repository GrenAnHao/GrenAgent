import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConfig } = vi.hoisted(() => ({ getConfig: vi.fn<(name: string) => string | undefined>() }));

vi.mock("../_shared/runtime-config.js", () => ({ getConfig }));
vi.mock("@tencentdb-agent-memory/memory-sdk-ts-v2", () => ({
  MemoryClient: class MemoryClient {},
}));

import { readMemoryConnectionConfig } from "./client.js";

const configured = new Map<string, string>([
  ["TDAI_MEMORY_ENDPOINT", "http://127.0.0.1:8420"],
  ["TDAI_MEMORY_API_KEY", "gateway-secret"],
  ["TDAI_MEMORY_SERVICE_ID", "personal-memory"],
  ["TDAI_MEMORY_TEAM_ID", "personal-local"],
  ["TDAI_MEMORY_AGENT_ID", "pi-personal"],
  ["TDAI_MEMORY_USER_ID", "local"],
]);

beforeEach(() => {
  getConfig.mockImplementation((name) => configured.get(name));
});

describe("readMemoryConnectionConfig", () => {
  it("requires the TencentDB user key used by management-plane clients", () => {
    expect(() => readMemoryConnectionConfig()).toThrow("TDAI_MEMORY_USER_KEY");
  });

  it("passes the configured user key to every TencentDB SDK client", () => {
    getConfig.mockImplementation((name) => name === "TDAI_MEMORY_USER_KEY" ? "user-secret" : configured.get(name));

    expect(readMemoryConnectionConfig()).toMatchObject({ userKey: "user-secret" });
  });
});
