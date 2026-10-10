import { describe, expect, it } from "vitest";
import { oauth } from "./oauth.js";

describe("oauth callback page", () => {
  it("shows the settings success text after a valid callback", async () => {
    let authorize = "";
    const pending = oauth(AbortSignal.timeout(8_000), (url) => { authorize = url; }, {
      port: 0,
      statusHoldMs: 0,
      successText: "授权完成。可以关闭此窗口，回到设置。",
      fetcher: async () => new Response(JSON.stringify({ token: "session-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    while (!authorize) await new Promise((resolve) => setTimeout(resolve, 10));
    const page = new URL(authorize);
    const redirect = new URL(page.searchParams.get("redirect_uri") ?? "");
    redirect.searchParams.set("code", "one-time-code");
    redirect.searchParams.set("state", page.searchParams.get("state") ?? "");
    const response = await fetch(redirect);
    expect(await response.text()).toBe("授权完成。可以关闭此窗口，回到设置。");
    expect(await pending).toBe("session-token");
  });
});
