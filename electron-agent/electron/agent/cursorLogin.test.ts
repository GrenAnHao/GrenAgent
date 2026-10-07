import { describe, expect, it } from "vitest";
import { startCursorLogin } from "./cursorLogin";

describe("startCursorLogin", () => {
  it("把带 challenge 和 uuid 的登录 URL 交给打开函数，不自己请求模型", async () => {
    const opened: string[] = [];
    const fetches: string[] = [];
    await startCursorLogin({
      agentDir: "C:/tmp/agent",
      openLoginUrl: async (url) => { opened.push(url); },
      fetch: async (input) => {
        fetches.push(String(input));
        return new Response(JSON.stringify({ accessToken: "a", refreshToken: "r" }), { status: 200 });
      },
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("https://cursor.com/loginDeepControl?");
    expect(opened[0]).toContain("challenge=");
    expect(opened[0]).toContain("uuid=");
    expect(fetches.some((url) => url.includes("api2.cursor.sh") && !url.includes("/auth/poll"))).toBe(false);
  });
});
