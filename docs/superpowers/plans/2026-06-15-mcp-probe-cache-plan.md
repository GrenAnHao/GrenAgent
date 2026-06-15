# MCP 工具探测与缓存 · Phase 3（管理面板解耦会话）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 让 MCP 管理面板**不再依赖 live 会话**显示工具：去掉「待连接/已连接」运行时状态，改为「测试连接（probe）→ 拉取工具清单 → 缓存成字典」，权限配置（三态/规则）读缓存字典，与有没有 agent 在跑彻底解耦。

**架构：** 复用现成 JS MCP SDK：sidecar 二进制新增一次性子命令 `pi probe-mcp`（读 `MCP_PROBE_CONFIG` 环境变量里的单个 server 配置 → 连接 → `listTools` → 把结果合并写入 `~/.pi/mcp-tools-cache.json` → 打印 `ProbeResult` JSON 到 stdout）。Rust 新增 `probe_mcp_server`（用 Tauri sidecar 一次性跑该子命令、回传 stdout）和 `read_mcp_tools_cache`。前端纯函数 `mcpToolsCache.ts` 解析缓存 + 构造探测配置；`McpServerCard` 去掉 live 状态、加「测试连接」按钮、工具列表读缓存；`ExtensionsPanel` 打开时读缓存并对「未缓存的已启用 server」自动探测一次。顺带：sidecar 的 `mcp` 扩展真正连接成功/失败时也把结果落到同一缓存（有会话时自动保鲜）。

**技术栈：** TypeScript + `@modelcontextprotocol/sdk`（stdio/SSE client）；Rust（tauri 2 command + `tauri-plugin-shell` 的 sidecar `.output()`）；React 19 + `@lobehub/ui` + antd（`Segmented`/`Switch`）+ antd-style（`createStaticStyles`/`cssVar`）+ lucide + vitest。

**前置事实（已核对现状）：**
- sidecar 是**按 workspace** 跑一个 `pi.exe`（`PiManager` 复用），mcp 扩展在**首次 `session_start`** 才连 server 并经 `setStatus("mcp", …)` 推 live 状态 → `ExtensionUiHost` → `mcpStatusStore` → `ExtensionsPanel`。这正是面板出现「待连接」的原因。
- `cli/src/main.ts` 的 `run()`：先判 `isRpcMode`，否则走官方 `main(argv,…)`。可在最前面加 `probe-mcp` 分支。
- `extensions/mcp/config.ts` 导出 `McpServerConfig`、`sanitize`；`extensions/mcp/index.ts` 用 `@modelcontextprotocol/sdk` 的 `Client`/`StdioClientTransport`/`SSEClientTransport` 连接，工具名格式 `mcp__${sanitize(server)}__${sanitize(tool)}`。
- Rust `pi/sidecar.rs` 用 `app.shell().sidecar("pi").args(...).env(...).spawn()`；`pub(crate) fn pi_package_dir()` 可复用。
- `tauri-plugin-shell` v2 的 `Command` 有 async `.output() -> Output { status, stdout, stderr }`。
- Tauri v2 invoke 会把 JS 端 camelCase 参数自动映射到 Rust 端 snake_case（如 `{ configJson }` → `config_json`），与现有 `write_mcp_policy({ content })` 一致。
- `~/.pi` 文件读写已有先例：`extensions/mcp-policy/index.ts`（node fs 原子写）与 `tauri-agent/src-tauri/src/commands/mcp_policy.rs`（Rust 读写，限 `~/.pi/`）。

**共享契约（跨任务务必一致）：**
- 缓存文件：`~/.pi/mcp-tools-cache.json`，形状 `{ "<serverName>": { "toolNames": string[], "probedAt": string(ISO), "ok": boolean, "error"?: string } }`。
- 探测子命令：`pi probe-mcp`（`process.argv[2] === "probe-mcp"`），输入走环境变量 `MCP_PROBE_CONFIG`（一个 `McpServerConfig` 的 JSON），stdout 仅打印一行 `ProbeResult` JSON。
- `ProbeResult`：`{ ok: boolean; toolNames: string[]; error?: string }`（定义在 `extensions/mcp/probe.ts`）。
- Rust 命令：`probe_mcp_server(config_json: String) -> Result<String,String>`（回传 ProbeResult JSON 文本）、`read_mcp_tools_cache() -> Result<String,String>`。
- 前端 io：`probeMcpServer(configJson): Promise<string>`、`readMcpToolsCache(): Promise<string>`。
- 前端纯函数（`mcpToolsCache.ts`）：`CacheEntry`、`ProbeResult`、`parseToolsCache`、`getCacheEntry`、`getCachedTools`、`toProbeConfigJson`、`parseProbeResult`。

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `extensions/mcp/probe.ts`（新） | `probeServer(cfg)`（MCP SDK 连接 + listTools，返回 ProbeResult）+ `runProbeCli()`（读 env、探测、写缓存、打印 JSON） |
| `extensions/mcp/toolsCache.ts`（新） | node-fs：`writeToolsCacheEntry(name, result)`（读-合并-原子写 `~/.pi/mcp-tools-cache.json`） |
| `extensions/mcp/probe.test.ts`（新） | `probeServer` 对不可启动 stdio 命令返回 `ok:false` 的确定性测试 |
| `cli/src/main.ts`（改） | `run()` 最前面加 `probe-mcp` 子命令分支 |
| `extensions/mcp/index.ts`（改） | `connectServer` 成功/失败分支调用 `writeToolsCacheEntry`（有会话时保鲜缓存） |
| `tauri-agent/src-tauri/src/commands/mcp_policy.rs`（改） | 加 `read_mcp_tools_cache` + `probe_mcp_server`（Tauri sidecar 一次性 `.output()`） |
| `tauri-agent/src-tauri/src/lib.rs`（改） | 注册 2 个 command |
| `tauri-agent/src/lib/mcpPolicyIo.ts`（改） | 加 `readMcpToolsCache`、`probeMcpServer` |
| `tauri-agent/src/features/extensions/mcpToolsCache.ts`（新） | 纯函数：解析缓存 / 取工具 / 构造探测配置 / 解析探测结果 + 类型 |
| `tauri-agent/src/features/extensions/mcpToolsCache.test.ts`（新） | 纯函数单测 |
| `tauri-agent/src/features/extensions/McpServerCard.tsx`（改） | 去掉 live 状态；加「测试连接」按钮；工具列表读缓存 |
| `tauri-agent/src/features/extensions/ExtensionsPanel.tsx`（改） | 读缓存 + 自动探测未缓存的已启用 server + onProbe；移除 `useMcpStatusStore` 使用 |

> 注：`mcpStatusStore.ts` 与 `ExtensionUiHost.tsx` 的 mcp 分支保持原样（仍会被 sidecar 写入，无害；本计划只是让面板不再读它），避免改动共享组件、缩小影响面。

---

## 任务 1：sidecar 探测核心（probe.ts + toolsCache.ts）

**文件：** 新 `extensions/mcp/probe.ts`、`extensions/mcp/toolsCache.ts`、`extensions/mcp/probe.test.ts`

- [ ] **步骤 1：写失败测试 `extensions/mcp/probe.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { probeServer } from "./probe";

describe("probeServer", () => {
  it("returns ok:false for an unspawnable stdio command", async () => {
    const r = await probeServer(
      { name: "x", transport: "stdio", command: "this_binary_does_not_exist_zzz", args: [] },
      4000,
    );
    expect(r.ok).toBe(false);
    expect(r.toolNames).toEqual([]);
    expect(typeof r.error).toBe("string");
  }, 15000);
});
```

- [ ] **步骤 2：运行验证失败** — `cd extensions && bunx vitest run mcp/probe.test.ts`，预期 FAIL（无法解析 `./probe` 模块）。

- [ ] **步骤 3：实现 `extensions/mcp/toolsCache.ts`**

```ts
// node-fs 缓存写入：读-合并-原子写 ~/.pi/mcp-tools-cache.json。与 mcp-policy 扩展同样的写法。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProbeResult } from "./probe.js";

const DIR = join(homedir(), ".pi");
const CACHE_PATH = join(DIR, "mcp-tools-cache.json");

export interface ToolsCacheEntry {
  toolNames: string[];
  probedAt: string;
  ok: boolean;
  error?: string;
}

export function writeToolsCacheEntry(name: string, result: ProbeResult): void {
  mkdirSync(DIR, { recursive: true });
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    raw = {};
  }
  const entry: ToolsCacheEntry = {
    toolNames: result.toolNames,
    probedAt: new Date().toISOString(),
    ok: result.ok,
  };
  if (result.error) entry.error = result.error;
  raw[name] = entry;
  const tmp = `${CACHE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2), "utf8");
  renameSync(tmp, CACHE_PATH);
}
```

- [ ] **步骤 4：实现 `extensions/mcp/probe.ts`**

```ts
// 一次性探测：连接单个 MCP server、listTools、回传/缓存工具名。复用 mcp 扩展同款 SDK + 名称规则。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sanitize, type McpServerConfig } from "./config.js";
import { writeToolsCacheEntry } from "./toolsCache.js";

export interface ProbeResult {
  ok: boolean;
  toolNames: string[];
  error?: string;
}

const PROBE_TIMEOUT_MS = Number(process.env.MCP_PROBE_TIMEOUT_MS ?? "30000") || 30000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

export async function probeServer(s: McpServerConfig, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const client = new Client({ name: "grenagent-probe", version: "0.1.0" });
  const transport =
    s.transport === "sse"
      ? new SSEClientTransport(new URL(s.url ?? ""))
      : new StdioClientTransport({
          command: s.command ?? "",
          args: s.args ?? [],
          env: { ...(process.env as Record<string, string>), ...(s.env ?? {}) },
        });
  try {
    await withTimeout(client.connect(transport), timeoutMs);
    const { tools } = await withTimeout(client.listTools(), timeoutMs);
    const toolNames = tools.map((t) => `mcp__${sanitize(s.name)}__${sanitize(t.name)}`);
    return { ok: true, toolNames };
  } catch (e) {
    return { ok: false, toolNames: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    await client.close().catch(() => {});
  }
}

// `pi probe-mcp` 子命令入口：读 MCP_PROBE_CONFIG（或 argv[3]）里的单个 server 配置，
// 探测、写缓存、把 ProbeResult 打到 stdout（仅这一行）。诊断信息一律走 stderr。
export async function runProbeCli(): Promise<void> {
  const raw = process.env.MCP_PROBE_CONFIG ?? process.argv[3] ?? "";
  let cfg: McpServerConfig | undefined;
  try {
    cfg = JSON.parse(raw) as McpServerConfig;
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, toolNames: [], error: "invalid MCP_PROBE_CONFIG" })}\n`);
    return;
  }
  const result = await probeServer(cfg);
  try {
    writeToolsCacheEntry(cfg.name, result);
  } catch (e) {
    console.error(`[mcp-probe] cache write failed: ${e instanceof Error ? e.message : e}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
```

- [ ] **步骤 5：运行验证通过** — `cd extensions && bunx vitest run mcp/probe.test.ts`，预期 PASS。

- [ ] **步骤 6：Commit**

```bash
git add extensions/mcp/probe.ts extensions/mcp/toolsCache.ts extensions/mcp/probe.test.ts
git commit -m "feat(mcp-probe-cache): one-shot probeServer + tools cache writer (任务1/7)"
```

---

## 任务 2：把探测接进 sidecar（main.ts 子命令 + index.ts 保鲜）

**文件：** 改 `cli/src/main.ts`、`extensions/mcp/index.ts`

- [ ] **步骤 1：`cli/src/main.ts` 加 `probe-mcp` 分支** — 在 `run()` 函数体最前面（`const argv = process.argv.slice(2);` 之后、`if (isRpcMode(argv)) {` 之前）插入：

```ts
  // 一次性探测子命令（管理面板「测试连接」用）：不启动 pi 运行时，仅连 MCP server 取工具名。
  if (argv[0] === "probe-mcp") {
    const { runProbeCli } = await import("../../extensions/mcp/probe.js");
    await runProbeCli();
    return;
  }
```

- [ ] **步骤 2：`extensions/mcp/index.ts` 顶部加 import** — 在 `import { injectDefaultServers, … } from "./config.js";` 之后加：

```ts
import { writeToolsCacheEntry } from "./toolsCache.js";
```

- [ ] **步骤 3：`connectServer` 成功分支写缓存** — 把成功分支：

```ts
      registry.set(s.name, { status: "connected", tools: tools.length, toolNames: newNames });
      console.error(`[mcp] connected "${s.name}" (${s.transport}); ${tools.length} tools registered`);
```

改为（在 console.error 之前补一行缓存写入）：

```ts
      registry.set(s.name, { status: "connected", tools: tools.length, toolNames: newNames });
      try {
        writeToolsCacheEntry(s.name, { ok: true, toolNames: newNames });
      } catch (cacheErr) {
        console.error(`[mcp] tools-cache write failed for "${s.name}": ${cacheErr instanceof Error ? cacheErr.message : cacheErr}`);
      }
      console.error(`[mcp] connected "${s.name}" (${s.transport}); ${tools.length} tools registered`);
```

- [ ] **步骤 4：`connectServer` 失败分支写缓存** — 把 catch 分支：

```ts
      const msg = e instanceof Error ? e.message : String(e);
      registry.set(s.name, { status: "failed", tools: 0, error: msg });
      console.error(`[mcp] failed to connect "${s.name}": ${msg}`);
```

改为：

```ts
      const msg = e instanceof Error ? e.message : String(e);
      registry.set(s.name, { status: "failed", tools: 0, error: msg });
      try {
        writeToolsCacheEntry(s.name, { ok: false, toolNames: [], error: msg });
      } catch {
        // best-effort cache; ignore
      }
      console.error(`[mcp] failed to connect "${s.name}": ${msg}`);
```

- [ ] **步骤 5：类型检查（extensions 无独立 tsc 工程，借 sidecar 编译间接验证）** — 运行 `cd tauri-agent && node scripts/build-sidecar.mjs`，预期成功（bun 能解析 `../../extensions/mcp/probe.js`/`toolsCache.js` 并打包；产出 `pi-<triple>.exe`）。

- [ ] **步骤 6：Commit**

```bash
git add cli/src/main.ts extensions/mcp/index.ts
git commit -m "feat(mcp-probe-cache): probe-mcp subcommand + connect-time cache refresh (任务2/7)"
```

---

## 任务 3：Rust command（probe_mcp_server + read_mcp_tools_cache）

**文件：** 改 `tauri-agent/src-tauri/src/commands/mcp_policy.rs`、`tauri-agent/src-tauri/src/lib.rs`

- [ ] **步骤 1：`mcp_policy.rs` 末尾追加两个 command**

```rust
#[tauri::command]
pub async fn read_mcp_tools_cache() -> Result<String, String> {
    let path = pi_dir()?.join("mcp-tools-cache.json");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn probe_mcp_server(app: tauri::AppHandle, config_json: String) -> Result<String, String> {
    use tauri_plugin_shell::ShellExt;
    let package_dir = crate::pi::sidecar::pi_package_dir();
    let output = app
        .shell()
        .sidecar("pi")
        .map_err(|e| format!("sidecar lookup failed: {e}"))?
        .args(["probe-mcp"])
        .env("PI_PACKAGE_DIR", package_dir)
        .env("MCP_PROBE_CONFIG", config_json)
        .output()
        .await
        .map_err(|e| format!("probe spawn failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "probe exited ({:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
```

- [ ] **步骤 2：`lib.rs` 注册** — 在 `commands::mcp_policy::read_mcp_audit,` 之后加：

```rust
            commands::mcp_policy::read_mcp_tools_cache,
            commands::mcp_policy::probe_mcp_server,
```

- [ ] **步骤 3：cargo check** — 关闭正在运行的 app（否则 `target/debug/pi.exe` 被占用、tauri-build 覆盖 sidecar 时报 PermissionDenied），然后 `cd tauri-agent/src-tauri && cargo check`，预期通过。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/mcp_policy.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(mcp-probe-cache): rust probe_mcp_server + read tools cache (任务3/7)"
```

---

## 任务 4：前端纯函数 + invoke 封装

**文件：** 新 `tauri-agent/src/features/extensions/mcpToolsCache.ts`、`mcpToolsCache.test.ts`；改 `tauri-agent/src/lib/mcpPolicyIo.ts`

- [ ] **步骤 1：写失败测试 `mcpToolsCache.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  getCacheEntry, getCachedTools, parseProbeResult, parseToolsCache, toProbeConfigJson,
} from './mcpToolsCache';

describe('parseToolsCache', () => {
  it('returns {} for empty / invalid', () => {
    expect(parseToolsCache('')).toEqual({});
    expect(parseToolsCache('nope')).toEqual({});
  });
  it('parses entries and reads tools', () => {
    const c = parseToolsCache(JSON.stringify({ s: { toolNames: ['mcp__s__t'], probedAt: 't1', ok: true } }));
    expect(getCachedTools(c, 's')).toEqual(['mcp__s__t']);
    expect(getCacheEntry(c, 's')?.ok).toBe(true);
  });
  it('tolerates malformed entries', () => {
    const c = parseToolsCache(JSON.stringify({ a: 5, b: { toolNames: 'x', ok: true } }));
    expect(getCachedTools(c, 'a')).toEqual([]);
    expect(getCachedTools(c, 'b')).toEqual([]);
    expect(getCachedTools(c, 'missing')).toEqual([]);
  });
});

describe('toProbeConfigJson', () => {
  it('stdio config', () => {
    expect(JSON.parse(toProbeConfigJson('s', { command: 'c', args: ['a'], env: { K: 'v' } }))).toEqual({
      name: 's', transport: 'stdio', command: 'c', args: ['a'], env: { K: 'v' },
    });
  });
  it('remote config → sse', () => {
    expect(JSON.parse(toProbeConfigJson('s', { url: 'http://x' }))).toEqual({
      name: 's', transport: 'sse', url: 'http://x',
    });
  });
});

describe('parseProbeResult', () => {
  it('parses ok result', () => {
    expect(parseProbeResult('{"ok":true,"toolNames":["mcp__s__t"]}')).toEqual({ ok: true, toolNames: ['mcp__s__t'] });
  });
  it('falls back on garbage', () => {
    expect(parseProbeResult('x')).toEqual({ ok: false, toolNames: [], error: 'invalid probe result' });
  });
});
```

- [ ] **步骤 2：运行验证失败** — `cd tauri-agent && bunx vitest run src/features/extensions/mcpToolsCache.test.ts`，预期 FAIL（模块缺失）。

- [ ] **步骤 3：实现 `mcpToolsCache.ts`**

```ts
import { transportOf, type McpConfig, type McpRemoteConfig, type McpStdioConfig } from './mcpConfig';

export interface CacheEntry {
  toolNames: string[];
  probedAt: string;
  ok: boolean;
  error?: string;
}

export interface ProbeResult {
  ok: boolean;
  toolNames: string[];
  error?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function parseToolsCache(json: string): Record<string, CacheEntry> {
  if (!json.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return {};
  }
  if (!isRecord(v)) return {};
  const out: Record<string, CacheEntry> = {};
  for (const [name, raw] of Object.entries(v)) {
    if (!isRecord(raw)) continue;
    out[name] = {
      toolNames: strArray(raw.toolNames),
      probedAt: typeof raw.probedAt === 'string' ? raw.probedAt : '',
      ok: raw.ok === true,
      ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
    };
  }
  return out;
}

export function getCacheEntry(cache: Record<string, CacheEntry>, name: string): CacheEntry | undefined {
  return cache[name];
}

export function getCachedTools(cache: Record<string, CacheEntry>, name: string): string[] {
  return cache[name]?.toolNames ?? [];
}

export function toProbeConfigJson(name: string, config: McpConfig): string {
  if (transportOf(config) === 'stdio') {
    const s = config as McpStdioConfig;
    return JSON.stringify({ name, transport: 'stdio', command: s.command, args: s.args ?? [], env: s.env ?? {} });
  }
  const r = config as McpRemoteConfig;
  return JSON.stringify({ name, transport: 'sse', url: r.url });
}

export function parseProbeResult(json: string): ProbeResult {
  try {
    const v = JSON.parse(json);
    if (isRecord(v) && typeof v.ok === 'boolean') {
      return { ok: v.ok, toolNames: strArray(v.toolNames), ...(typeof v.error === 'string' ? { error: v.error } : {}) };
    }
  } catch {
    // fall through
  }
  return { ok: false, toolNames: [], error: 'invalid probe result' };
}
```

- [ ] **步骤 4：运行验证通过** — 同命令，预期 PASS。

- [ ] **步骤 5：`mcpPolicyIo.ts` 追加两个封装** — 在文件末尾加：

```ts
export function readMcpToolsCache(): Promise<string> {
  return invoke<string>('read_mcp_tools_cache');
}

export function probeMcpServer(configJson: string): Promise<string> {
  return invoke<string>('probe_mcp_server', { configJson });
}
```

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/extensions/mcpToolsCache.ts tauri-agent/src/features/extensions/mcpToolsCache.test.ts tauri-agent/src/lib/mcpPolicyIo.ts
git commit -m "feat(mcp-probe-cache): tools-cache helpers + probe/readCache io (任务4/7)"
```

---

## 任务 5：McpServerCard 改造（去 live 状态 + 测试连接 + 读缓存）

**文件：** 改 `tauri-agent/src/features/extensions/McpServerCard.tsx`（整体替换）

- [ ] **步骤 1：整体替换为下述内容**

```tsx
import { Segmented, Switch } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { ChevronDown, ChevronRight, PencilLine, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { transportOf, type McpConfig } from './mcpConfig';
import { getToolPerm, shortToolName, type Perm } from './mcpPolicy';

interface McpServerCardProps {
  name: string;
  config: McpConfig;
  enabled: boolean;
  cachedTools?: string[];
  probing?: boolean;
  probeError?: string;
  policyRaw?: Record<string, unknown>;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onProbe?: () => void;
  onPermChange?: (fullName: string, perm: Perm) => void;
  onOpenRules?: (fullName: string) => void;
}

const PERM_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '需审批', value: 'needs_approval' },
  { label: '禁用', value: 'disabled' },
];

function statusText(probing: boolean, probeError: string | undefined, count: number): string {
  if (probing) return '探测中…';
  if (probeError) return '连接失败';
  if (count > 0) return `${count} 工具`;
  return '未探测';
}

function statusColor(probing: boolean, probeError: string | undefined, count: number): string {
  if (probing) return '#f5a623';
  if (probeError) return '#f5635b';
  if (count > 0) return '#3ddc84';
  return '#8a8f98';
}

const styles = createStaticStyles(({ css }) => ({
  wrap: css`
    margin-block-end: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
    overflow: hidden;
  `,
  card: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 14px;
  `,
  disabled: css`
    opacity: 0.55;
  `,
  expandBtn: css`
    display: inline-flex;
    border: none;
    background: transparent;
    color: ${cssVar.colorTextTertiary};
    cursor: pointer;
  `,
  dot: css`
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: 50%;
  `,
  name: css`
    font-size: 13px;
    color: ${cssVar.colorText};
  `,
  pill: css`
    padding: 1px 8px;
    border-radius: 6px;
    background: ${cssVar.colorFillTertiary};
    color: ${cssVar.colorTextSecondary};
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    text-transform: uppercase;
  `,
  grow: css`
    flex: 1;
    min-width: 0;
  `,
  status: css`
    font-size: 11px;
  `,
  ops: css`
    display: flex;
    align-items: center;
    gap: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  iconbtn: css`
    display: inline-flex;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;

    &:disabled {
      cursor: default;
      opacity: 0.5;
    }
  `,
  spin: css`
    animation: mcp-probe-spin 0.9s linear infinite;

    @keyframes mcp-probe-spin {
      to {
        transform: rotate(360deg);
      }
    }
  `,
  tools: css`
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    padding: 6px 14px 10px;
  `,
  toolRow: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding-block: 6px;
  `,
  toolName: css`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  hint: css`
    padding: 8px 0;
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
}));

export function McpServerCard({
  name, config, enabled, cachedTools = [], probing = false, probeError, policyRaw = {},
  onToggle, onEdit, onDelete, onProbe, onPermChange, onOpenRules,
}: McpServerCardProps) {
  const [expanded, setExpanded] = useState(false);
  const color = statusColor(probing, probeError, cachedTools.length);
  return (
    <div className={styles.wrap} data-testid={`mcp-server-${name}`}>
      <div className={`${styles.card} ${enabled ? '' : styles.disabled}`}>
        <button
          type="button"
          className={styles.expandBtn}
          data-testid={`mcp-expand-${name}`}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <span className={styles.dot} style={{ background: color }} />
        <span className={styles.name}>{name}</span>
        <span className={styles.pill}>{transportOf(config)}</span>
        <span className={styles.grow} />
        <span className={styles.status} style={{ color }}>{statusText(probing, probeError, cachedTools.length)}</span>
        <span className={styles.ops}>
          <button
            type="button"
            className={styles.iconbtn}
            title="测试连接"
            data-testid={`mcp-probe-${name}`}
            disabled={probing}
            onClick={onProbe}
          >
            <RefreshCw size={14} className={probing ? styles.spin : undefined} />
          </button>
          <Switch size="small" checked={enabled} onChange={onToggle} data-testid={`mcp-toggle-${name}`} />
          <button type="button" className={styles.iconbtn} data-testid={`mcp-edit-${name}`} onClick={onEdit}>
            <PencilLine size={15} />
          </button>
          <button type="button" className={styles.iconbtn} data-testid={`mcp-delete-${name}`} onClick={onDelete}>
            <Trash2 size={15} />
          </button>
        </span>
      </div>
      {expanded ? (
        <div className={styles.tools}>
          {cachedTools.length === 0 ? (
            <div className={styles.hint}>{probeError ? `连接失败：${probeError}` : '点右侧「测试连接」获取工具列表'}</div>
          ) : (
            cachedTools.map((full) => (
              <div key={full} className={styles.toolRow} data-testid={`mcp-tool-${full}`}>
                <span className={styles.toolName} title={full}>{shortToolName(full)}</span>
                <Segmented
                  size="small"
                  value={getToolPerm(policyRaw, full)}
                  options={PERM_OPTIONS}
                  onChange={(v) => onPermChange?.(full, v as Perm)}
                  data-testid={`mcp-perm-${full}`}
                />
                <button
                  type="button"
                  className={styles.iconbtn}
                  title="参数规则"
                  data-testid={`mcp-rules-${full}`}
                  onClick={() => onOpenRules?.(full)}
                >
                  <SlidersHorizontal size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **步骤 2：类型检查** — `cd tauri-agent && bunx tsc --noEmit 2>&1 | Select-String -Pattern "McpServerCard"`，预期无输出（`ExtensionsPanel` 仍传 `live=`，但 `live` 已不在 props 上 → 会有 `ExtensionsPanel.tsx` 的报错，任务 6 修复；本步只确认 `McpServerCard.tsx` 自身无错）。

> 说明：此时整库 tsc 会因 `ExtensionsPanel` 旧的 `live=` prop 报错，属预期，任务 6 接线后消除。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/extensions/McpServerCard.tsx
git commit -m "feat(mcp-probe-cache): card drops live status, adds probe + cached tools (任务5/7)"
```

---

## 任务 6：ExtensionsPanel 接线（读缓存 + 自动探测 + onProbe）

**文件：** 改 `tauri-agent/src/features/extensions/ExtensionsPanel.tsx`

- [ ] **步骤 1：删除 live 状态 import** — 删掉这一行：

```tsx
import { useMcpStatusStore } from '../../stores/mcpStatusStore';
```

- [ ] **步骤 2：补充 io / 纯函数 import** — 把现有这一行：

```tsx
import { parsePolicyDoc, serializePolicyDoc, setToolPerm, setToolRules, type Perm } from './mcpPolicy';
```

替换为（其后补一行 toolsCache import）：

```tsx
import { parsePolicyDoc, serializePolicyDoc, setToolPerm, setToolRules, type Perm } from './mcpPolicy';
import { getCacheEntry, getCachedTools, parseToolsCache, toProbeConfigJson, type CacheEntry } from './mcpToolsCache';
```

并把现有的：

```tsx
import { readMcpPolicy, writeMcpPolicy } from '../../lib/mcpPolicyIo';
```

替换为：

```tsx
import { probeMcpServer, readMcpPolicy, readMcpToolsCache, writeMcpPolicy } from '../../lib/mcpPolicyIo';
```

- [ ] **步骤 3：删除 live 状态读取** — 删掉这两行：

```tsx
  const liveMcp = useMcpStatusStore((s) => s.servers);
  const liveMcpByName = new Map(liveMcp.map((s) => [s.name, s]));
```

- [ ] **步骤 4：加缓存 state + 加载/自动探测 + probeOne** — 在现有 `const onPermChange = …;` 这一行之后插入：

```tsx
  const [toolsCache, setToolsCache] = useState<Record<string, CacheEntry>>({});
  const [probing, setProbing] = useState<Set<string>>(new Set());

  const reloadCache = async () => {
    try {
      setToolsCache(parseToolsCache(await readMcpToolsCache()));
    } catch {
      // ignore: empty cache renders as 未探测
    }
  };

  const probeOne = async (serverName: string, serverConfig: McpConfig) => {
    setProbing((s) => new Set(s).add(serverName));
    try {
      await probeMcpServer(toProbeConfigJson(serverName, serverConfig));
    } catch {
      // probe failure is recorded in cache by the subcommand; ignore here
    } finally {
      await reloadCache();
      setProbing((s) => {
        const next = new Set(s);
        next.delete(serverName);
        return next;
      });
    }
  };

  // 打开面板：读缓存，并对「已启用但还没缓存过」的 server 自动探测一次（顺序执行，避免一次 spawn 一堆 npx）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let cache: Record<string, CacheEntry> = {};
      try {
        cache = parseToolsCache(await readMcpToolsCache());
      } catch {
        cache = {};
      }
      if (cancelled) return;
      setToolsCache(cache);
      const toProbe = listEntries({
        enabled: values.MCP_SERVERS ?? '',
        disabled: values.MCP_SERVERS_DISABLED ?? '',
      }).filter((e) => e.enabled && !cache[e.name]);
      for (const e of toProbe) {
        if (cancelled) return;
        await probeOne(e.name, e.config);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);
```

> 说明：依赖用 `[loading]`，等设置首次加载完成后再读 `values.MCP_SERVERS` 拿到真实 server 列表；`probeOne`/`reloadCache` 为组件内闭包，刻意不进依赖数组（用 eslint-disable 抑制 exhaustive-deps，与本组件既有「自动存盘」effect 的风格一致）。

- [ ] **步骤 5：给 `<McpServerCard>` 换 props** — 把现有：

```tsx
                    live={liveMcpByName.get(e.name)}
                    policyRaw={policyRaw}
                    onToggle={(v) => handleToggleMcp(e.name, v)}
                    onEdit={() => {
                      setEditing(e);
                      setModalOpen(true);
                    }}
                    onDelete={() => handleDeleteMcp(e.name)}
                    onPermChange={onPermChange}
                    onOpenRules={(full) => setRulesTarget(full)}
```

替换为：

```tsx
                    cachedTools={getCachedTools(toolsCache, e.name)}
                    probing={probing.has(e.name)}
                    probeError={getCacheEntry(toolsCache, e.name)?.ok === false ? getCacheEntry(toolsCache, e.name)?.error : undefined}
                    policyRaw={policyRaw}
                    onToggle={(v) => handleToggleMcp(e.name, v)}
                    onEdit={() => {
                      setEditing(e);
                      setModalOpen(true);
                    }}
                    onDelete={() => handleDeleteMcp(e.name)}
                    onProbe={() => void probeOne(e.name, e.config)}
                    onPermChange={onPermChange}
                    onOpenRules={(full) => setRulesTarget(full)}
```

- [ ] **步骤 6：更新 hero 描述文案（去掉「重启后生效」误导）** — 把：

```tsx
                连接外部 MCP server，其工具以 <code className={styles.code}>mcp__server__tool</code> 暴露给 agent（改动自动保存，重启后生效）。
```

改为：

```tsx
                连接外部 MCP server，其工具以 <code className={styles.code}>mcp__server__tool</code> 暴露给 agent。点「测试连接」获取工具并配置权限（即时生效）。
```

- [ ] **步骤 7：前端类型检查 + 单测**

运行：`cd tauri-agent && bunx tsc --noEmit && bunx vitest run src/features/extensions/ src/stores/mcpStatusStore.test.ts`
预期：tsc 0 错（与本改动相关的）；测试全绿。

- [ ] **步骤 8：Commit**

```bash
git add tauri-agent/src/features/extensions/ExtensionsPanel.tsx
git commit -m "feat(mcp-probe-cache): panel reads cache + auto/manual probe, drops live status (任务6/7)"
```

---

## 任务 7：全量验证 + 冒烟

**文件：** 无新增（集成验证）

- [ ] **步骤 1：前端类型检查 + 全量扩展单测**

运行：`cd tauri-agent && bunx tsc --noEmit && bunx vitest run src/features/extensions/ src/stores/mcpStatusStore.test.ts`
预期：tsc 0 错；测试全绿。

- [ ] **步骤 2：extensions 单测**

运行：`cd extensions && bunx vitest run mcp/probe.test.ts`
预期：PASS。

- [ ] **步骤 3：sidecar 构建（把 probe-mcp 子命令打进二进制）**

运行：`cd tauri-agent && node scripts/build-sidecar.mjs`
预期：成功，产出 `src-tauri/binaries/pi-<triple>.exe`。

- [ ] **步骤 4：cargo check**

先关闭正在运行的 app（释放 `target/debug/pi.exe` 占用），再 `cd tauri-agent/src-tauri && cargo check`。预期通过。

- [ ] **步骤 5：端到端冒烟（手动，建议）**

1. 完整重启 app（`bunx tauri dev`，确保带新 Rust command + 新 sidecar）。
2. 进「插件 → MCP」：卡片应显示「N 工具 / 未探测 / 探测中… / 连接失败」（不再有「待连接」）。
3. 对某 server 点「测试连接」→ 成功后状态变「N 工具」，展开看到工具列表；检查 `~/.pi/mcp-tools-cache.json` 出现该 server 条目（含 `toolNames`/`probedAt`/`ok`）。
4. 对某工具设「禁用」→ 让 agent 调它 → 被 block（策略热加载，无需重启）。
5. 点工具「规则」加 `match: {query: "*secret*"} / always` → 保存；检查 `~/.pi/mcp-policy.json` 更新且保留其他工具。
6. 关一个会触发失败的 server（如改坏 command）点「测试连接」→ 状态「连接失败」，hover/展开看到 error；缓存条目 `ok:false`。

- [ ] **步骤 6：Commit（如冒烟中有微调）**

```bash
git add -A
git commit -m "test(mcp-probe-cache): e2e smoke fixes (任务7/7)"
```

---

## 自检（规格覆盖度对照）

| 设计点 / 需求 | 对应任务 |
|----------------|----------|
| 一次性探测（连接 + listTools，复用 JS MCP SDK） | 任务 1（`probeServer`） |
| 探测结果写缓存 `~/.pi/mcp-tools-cache.json` | 任务 1（`writeToolsCacheEntry`）+ 任务 2（连接时保鲜） |
| `pi probe-mcp` 子命令 | 任务 2 |
| 有会话连接时缓存自动保鲜 | 任务 2（index.ts 成功/失败分支） |
| Rust 触发探测 + 读缓存（限 ~/.pi/） | 任务 3 |
| 前端缓存解析 / 取工具 / 构造探测配置（纯函数） | 任务 4 |
| invoke 封装 probe/readCache | 任务 4 |
| 管理面板去掉 live「待连接」状态 | 任务 5（card）+ 任务 6（panel 删 store 使用） |
| 「测试连接」按钮（手动探测） | 任务 5（onProbe）+ 任务 6（probeOne） |
| 工具列表/权限三态/规则读缓存字典 | 任务 5（cachedTools）+ 任务 6（接线） |
| 打开面板自动探测未缓存的已启用 server | 任务 6（mount effect） |
| 权限即时生效（策略热加载，不重启） | 既有阶段 1（`mcp-policy` 扩展按 mtime 重读）+ 任务 6 文案 |

**类型一致性：** `ProbeResult` 在 `extensions/mcp/probe.ts` 与 `tauri-agent/.../mcpToolsCache.ts` 两侧形状一致（`{ok, toolNames, error?}`）；缓存形状 `CacheEntry` ↔ `ToolsCacheEntry` 字段一致（`toolNames/probedAt/ok/error?`）；Rust `probe_mcp_server(config_json)` ↔ 前端 `probeMcpServer(configJson)`（Tauri 自动 camel↔snake）；`read_mcp_tools_cache` ↔ `readMcpToolsCache`；`McpServerCard` 的 `cachedTools/probing/probeError/onProbe` 与 `ExtensionsPanel` 传参一致。

**占位符扫描：** 无 TODO/待定；每个新文件/改动均有完整代码。

**依赖顺序：** 任务 1（探测核心）→ 任务 2（接入 sidecar，依赖 1）→ 任务 3（Rust 跑子命令，依赖 2 的子命令存在；cargo check 仅类型检查，真实探测在任务 7 sidecar 重建后才可用）→ 任务 4（前端纯函数/io）→ 任务 5（card，依赖 4 的类型）→ 任务 6（panel 收口，依赖 4/5）→ 任务 7（全量验证 + sidecar 重建）。

---

## 执行交接

两种执行方式：

1. **子代理驱动（推荐）**：每任务一个子代理 + 任务间审查。必需子技能 superpowers:subagent-driven-development。
2. **内联执行**：当前会话用 superpowers:executing-plans 批量执行 + 检查点。
