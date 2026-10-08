import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: vi.fn(),
}));

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import promptCommands from "./index.js";

type InputHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

function setup(): InputHandler {
  const handlers = new Map<string, InputHandler>();
  promptCommands({ on: (event: string, handler: InputHandler) => handlers.set(event, handler) } as never);
  return handlers.get("input")!;
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-commands-"));
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts", "refactor.md"), "---\ndescription: x\n---\n改 {file}");
  vi.mocked(getAgentDir).mockReturnValue(dir);
});

describe("prompt-commands input 钩子", () => {
  it("展开带参数的模板，图片原样带上", async () => {
    const images = [{ type: "image", data: "x", mimeType: "image/png" }];
    const result = await setup()({ type: "input", text: '/refactor "a.ts"', images, source: "rpc" }, { ui: { notify: vi.fn() } });
    expect(result).toEqual({
      action: "transform",
      text: '<command name="refactor" args="{&quot;file&quot;:&quot;a.ts&quot;}">\n改 a.ts\n</command>',
      images,
    });
  });

  it("缺参数时提示并拦下", async () => {
    const notify = vi.fn();
    const result = await setup()({ type: "input", text: "/refactor", source: "rpc" }, { ui: { notify } });
    expect(result).toEqual({ action: "handled" });
    expect(notify).toHaveBeenCalledWith("命令 /refactor 缺少参数：file", "error");
  });

  it("其他输入放行", async () => {
    expect(await setup()({ type: "input", text: "你好", source: "rpc" }, { ui: { notify: vi.fn() } })).toEqual({
      action: "continue",
    });
  });
});
