import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchMcpConfigFiles } from "./mcp-store.js";

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function layout() {
  const root = mkdtempSync(join(tmpdir(), "mcp-store-watch-"));
  dirs.push(root);
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  return { home, cwd, agentDir: join(home, ".pi", "agent") };
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

describe("watchMcpConfigFiles", () => {
  it("~/.pi/agent 里其他文件（日志、数据库、会话）的写入不触发重读", async () => {
    const { home, cwd, agentDir } = layout();
    const onChange = vi.fn();
    stops.push(watchMcpConfigFiles(cwd, onChange, home));
    await settle(100);
    writeFileSync(join(agentDir, "mcp.log"), "line\n");
    writeFileSync(join(agentDir, "memory.db"), "x");
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("mcp.json 连续几次写入合并成一次重读", async () => {
    const { home, cwd, agentDir } = layout();
    const onChange = vi.fn();
    stops.push(watchMcpConfigFiles(cwd, onChange, home));
    await settle(100);
    writeFileSync(join(agentDir, "mcp.json"), '{"mcpServers":{}}');
    writeFileSync(join(agentDir, "mcp.json"), '{"mcpServers":{"a":{"command":"x"}}}');
    writeFileSync(join(cwd, ".pi", "mcp.json"), '{"mcpServers":{}}');
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("停止监听后不再回调，挂起的防抖也取消", async () => {
    const { home, cwd, agentDir } = layout();
    const onChange = vi.fn();
    const stop = watchMcpConfigFiles(cwd, onChange, home);
    await settle(100);
    writeFileSync(join(agentDir, "mcp.json"), "{}");
    stop();
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });
});
