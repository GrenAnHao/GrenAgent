import { describe, expect, it, vi } from "vitest";
import visualCompanion from "./index.ts";

interface VisualTool { execute: (...args: any[]) => Promise<any> }

describe("show_visual", () => {
  it("fails old visual waits immediately without allocating a UI request or timeout", async () => {
    const tools = new Map<string, VisualTool>();
    visualCompanion({ registerTool: (tool: VisualTool & { name: string }) => tools.set(tool.name, tool), on: () => () => {} } as never);
    const input = vi.fn();
    const result = await tools.get("read_visual_choice")!.execute("legacy", { timeout: 300 }, undefined, undefined, { ui: { input } });
    expect(result).toMatchObject({ isError: true, details: { error: "VISUAL_REVIEW_MIGRATED" } });
    expect(input).not.toHaveBeenCalled();
  });
  it("publishes a unique preview identity in status, inline notice and result details", async () => {
    const tools = new Map<string, VisualTool>();
    const sendMessage = vi.fn();
    visualCompanion({ registerTool: (tool: VisualTool & { name: string }) => tools.set(tool.name, tool), sendMessage, on: () => () => {} } as never);
    const status = vi.fn();
    const ctx = { cwd: process.cwd(), ui: { setStatus: status }, sessionManager: { getSessionFile: () => "owner-show" } };
    const first = await tools.get("show_visual")!.execute("show-1", { html: "<p>first</p>", mode: "inline" }, undefined, undefined, ctx);
    const second = await tools.get("show_visual")!.execute("show-2", { html: "<p>second</p>", mode: "inline" }, undefined, undefined, ctx);
    expect(first.details.previewId).toBeTruthy();
    expect(second.details.previewId).not.toBe(first.details.previewId);
    expect(JSON.parse(status.mock.calls[1][1]).previewId).toBe(second.details.previewId);
    expect(sendMessage.mock.calls[1][0].details.previewId).toBe(second.details.previewId);
  });
});
