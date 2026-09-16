# 代码智能内置 · Phase 1（地基 + 离线引擎）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 把 CodeGraph 作为默认、离线、零配置的代码图谱引擎内置进 Hermes：捆绑二进制 + 默认 MCP 注入（带「用户自配让位」）+ 每个 workspace 自动 init + 索引状态命令。

**架构：** sidecar(Node) 侧新增 `code-intel` 引擎抽象，扩展现有 `injectDefaultServers` 把激活引擎注入为默认 MCP server（命令指向随 app 打包的二进制，经 `PI_PACKAGE_DIR` 解析）；Tauri(Rust) 侧新增一次性 spawn 命令做 status/init/sync/reindex，并在 open_workspace 时按需自动 init。

**技术栈：** TypeScript（extensions sidecar）、Vitest、Rust（tauri commands、tauri-plugin-shell sidecar）、esbuild/bun 构建脚本、tauri externalBin。

**对应规格：** `docs/superpowers/specs/2026-06-17-code-intelligence-builtin-design.md`（Spec 0 + Spec 1）。

---

## 实现纪要（2026-06-17 执行）

> 本节记录实际落地与原计划的偏差、各任务状态、验证结果。原计划下文的「单文件二进制 / externalBin」描述已被「目录型 bundle / resources」取代，代码块仅作参考。

**关键偏差：CodeGraph 是目录型 bundle，不是单文件二进制。** 执行期核实：`@colbymchenry/codegraph` 主 npm 包仅为 JS 垫片，真实产物是 6 个逐平台包 / GitHub Releases 归档（`codegraph-<platform>-<arch>.tar.gz·zip`），每个内含 bundled Node 24 + `lib/dist` + `bin` launcher。单文件 `externalBin` 装不下，经用户确认采用「目录捆绑 + `bundle.resources`」（方案 A）。

**子命令核实（本机实跑 `--help`）：** `serve --mcp [--path] [--no-watch]`（serve 为隐藏命令）、`init [path]`（建 .codegraph + 建图一步）、`index -f [path]`（全量重建）、`sync [path]`（增量）、`status [path]`（人类可读文本，带 ANSI）。`--path` 在 MCP 模式可选，但注入仍显式传 `--path ${workspaceFolder}` 与本机 user MCP 配置一致。

**各任务落地：**

| 任务 | 状态 | 落地说明 |
| --- | --- | --- |
| 1 引擎抽象 | 已完成 | `engines.ts`：`buildConfig` 改为指向 bundle launcher，平台分支（unix `bin/codegraph`；win32 `node.exe --liftoff-only lib/dist/bin/codegraph.js`），args 含 `--path ${workspaceFolder}`。 |
| 2 默认注入 + 让位 | 已完成 | `config.ts injectDefaultServers` + `manager.ts` 接 `readToolsCache()`；签名/同名让位不变。 |
| 3 捆绑二进制 | 已完成（改目录方案） | 新 `build-codegraph.mjs` 从 GitHub Releases 下载平台 bundle 整目录 → `src-tauri/binaries/codegraph/`（pin `1.0.1`，含 SHA256 校验、strip-components）；`tauri.conf.json` 用 `bundle.resources: ["binaries/codegraph/**/*"]`（`externalBin` 不变）；`package.json` 加 `build:codegraph`。 |
| 4 Rust 命令 | 已完成 | `commands/code_intel.rs`：5 命令（status/init/sync/reindex/is_initialized），`tokio::process` 直跑 launcher，平台分支 + resource/dev 双路径解析；`mod.rs`/`lib.rs` 已注册。 |
| 5 自动 init | 已完成 | `commands/agent.rs::open_workspace`：成功 spawn 后、返回前，`CODE_INTEL!=off && CODE_INTEL_AUTO_INIT!=0 && 无 .codegraph` 时 `async_runtime::spawn` 后台 `code_intel_init`（失败仅日志）。 |
| 6 前端 IO 薄层 | 已完成 | `src/lib/codeIntelIo.ts` 命令名与 Rust 一致。 |

**验证状态：**

- 本机已验证：`extensions` 单测 `code-intel/engines.test.ts` + `mcp/config.test.ts` 共 26 passed；`build-codegraph.mjs` 实跑下载 win32-x64 bundle 成功，launcher `--version` = 1.0.1；`cargo check` 38.74s 零 error/warning；前端 `tsc --noEmit` 中 codeIntelIo 相关 0 错误（唯一既有错误 `App.tsx(640,88)` 与本任务无关）。
- 待 build 环境验证（本机受限：app 运行锁 / OneDrive / 需完整 tauri 构建）：`npm run build:codegraph && tauri build/dev` 后确认打开未索引项目数秒生成 `.codegraph/` 且 MCP 列表出现非空 `codegraph` server；prod 安装包 resources 路径解析；各 target triple 的 `build:codegraph`（CI 矩阵）。

---

## 文件结构

- 创建 `extensions/code-intel/engines.ts` — 引擎注册表（纯函数：名称/工具前缀/构建 McpServerConfig/签名识别）。职责：定义 CodeGraph(+GitNexus 占位) 引擎元数据，无 I/O。
- 创建 `extensions/code-intel/engines.test.ts` — engines 单测。
- 修改 `extensions/mcp/config.ts` — `injectDefaultServers` 增加按 `CODE_INTEL` 注入激活引擎 + 让位逻辑。
- 创建/修改 `extensions/mcp/config.test.ts` — 注入与让位单测。
- 修改 `tauri-agent/src-tauri/tauri.conf.json` — `externalBin` 增加 `binaries/codegraph`。
- 创建 `tauri-agent/scripts/build-codegraph.mjs` — build 期把 pinned 版 codegraph 二进制放入 `src-tauri/binaries/codegraph-<triple>`。
- 修改 `tauri-agent/package.json` — 增加 `build:codegraph` 脚本。
- 创建 `tauri-agent/src-tauri/src/commands/code_intel.rs` — `code_intel_status/init/sync/reindex` 一次性 spawn 捆绑二进制。
- 修改 `tauri-agent/src-tauri/src/commands/mod.rs` — `pub mod code_intel;`。
- 修改 `tauri-agent/src-tauri/src/lib.rs` — 注册 4 个命令。
- 修改 `tauri-agent/src-tauri/src/commands/workspaces.rs`（或 open_workspace 所在文件）— open 后按需触发自动 init（非阻塞）。
- 创建 `tauri-agent/src/lib/codeIntelIo.ts` — 前端 invoke 包装（Phase 3 UI 复用，先建薄层）。

---

## 任务 1：引擎抽象 `engines.ts`

**文件：**
- 创建：`extensions/code-intel/engines.ts`
- 测试：`extensions/code-intel/engines.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// extensions/code-intel/engines.test.ts
import { describe, expect, it } from "vitest";
import { getEngine, listEngineNames, matchesEngineSignature } from "./engines.js";

describe("code-intel engines", () => {
  it("codegraph builds a stdio McpServerConfig pointing at the bundled binary", () => {
    const cfg = getEngine("codegraph")!.buildConfig("/pkg", "linux");
    expect(cfg.name).toBe("codegraph");
    expect(cfg.transport).toBe("stdio");
    expect(cfg.command).toBe("/pkg/codegraph");
    expect(cfg.args).toEqual(["serve", "--mcp"]);
  });

  it("codegraph appends .exe on win32", () => {
    expect(getEngine("codegraph")!.buildConfig("C:/pkg", "win32").command).toBe("C:/pkg/codegraph.exe");
  });

  it("unknown engine returns undefined", () => {
    expect(getEngine("nope")).toBeUndefined();
  });

  it("lists known engine names", () => {
    expect(listEngineNames()).toContain("codegraph");
  });

  it("recognizes a user server exposing codegraph_* tools as the codegraph signature", () => {
    expect(matchesEngineSignature("codegraph", ["codegraph_explore", "codegraph_search"])).toBe(true);
    expect(matchesEngineSignature("codegraph", ["read_file"])).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run code-intel/engines.test.ts`
预期：FAIL，`Cannot find module './engines.js'`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// extensions/code-intel/engines.ts
// 代码图谱引擎注册表。纯元数据 + 纯函数，无 I/O，便于测试与互换。
import type { McpServerConfig } from "../mcp/config.js";

export interface CodeIntelEngine {
  /** 注入用的规范 MCP server 名（也是让位判定的同名键）。 */
  serverName: string;
  /** 该引擎暴露的工具前缀，用于「签名识别」用户自配同类引擎。 */
  toolPrefix: string;
  /** 由捆绑目录与平台构建 stdio McpServerConfig。 */
  buildConfig: (pkgDir: string, platform: string) => McpServerConfig;
}

function binPath(pkgDir: string, base: string, platform: string): string {
  const ext = platform === "win32" ? ".exe" : "";
  // pkgDir 由 PI_PACKAGE_DIR 提供（sidecar.rs 指向 binaries/）。
  return `${pkgDir.replace(/[\\/]+$/, "")}/${base}${ext}`;
}

const ENGINES: Record<string, CodeIntelEngine> = {
  codegraph: {
    serverName: "codegraph",
    toolPrefix: "codegraph_",
    buildConfig: (pkgDir, platform) => ({
      name: "codegraph",
      transport: "stdio",
      command: binPath(pkgDir, "codegraph", platform),
      args: ["serve", "--mcp"],
      env: {},
    }),
  },
  // GitNexus 为 Phase 4 opt-in 引擎，先登记元数据占位（buildConfig 待该阶段实现真实命令）。
  gitnexus: {
    serverName: "gitnexus",
    toolPrefix: "",
    buildConfig: (pkgDir, platform) => ({
      name: "gitnexus",
      transport: "stdio",
      command: binPath(pkgDir, "gitnexus", platform),
      args: ["mcp"],
      env: {},
    }),
  },
};

export function getEngine(name: string): CodeIntelEngine | undefined {
  return ENGINES[name];
}

export function listEngineNames(): string[] {
  return Object.keys(ENGINES);
}

/** 用户自配的某 server 暴露的工具是否命中某引擎签名（即便其 server 名不同）。 */
export function matchesEngineSignature(engineName: string, toolNames: string[]): boolean {
  const eng = ENGINES[engineName];
  if (!eng || !eng.toolPrefix) return false;
  return toolNames.some((t) => t.startsWith(eng.toolPrefix));
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run code-intel/engines.test.ts`
预期：PASS（5 passed）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/code-intel/engines.ts extensions/code-intel/engines.test.ts
git commit -m "feat(code-intel): engine registry abstraction (codegraph default)"
```

---

## 任务 2：默认 MCP 注入 + 让位策略

**文件：**
- 修改：`extensions/mcp/config.ts`（`injectDefaultServers`）
- 测试：`extensions/mcp/config.test.ts`

注：`injectDefaultServers(servers, env, platform)` 现有签名保持不变；新增逻辑读 `env.CODE_INTEL` 与 `env.PI_PACKAGE_DIR`，并接收一个「用户各 server 已知工具名」的来源用于签名识别。为保持纯函数可测，签名识别用 `env` 之外的可选第 4 参数注入工具映射（缺省为空 → 仅做同名判定）。

- [ ] **步骤 1：编写失败的测试**

```ts
// 追加到 extensions/mcp/config.test.ts
import { describe, expect, it } from "vitest";
import { injectDefaultServers, parseMcpServers } from "./config.js";

const base = { PI_PACKAGE_DIR: "/pkg" } as Record<string, string | undefined>;

describe("injectDefaultServers · code-intel", () => {
  it("injects codegraph by default", () => {
    const out = injectDefaultServers([], { ...base, CODE_INTEL: "codegraph" }, "linux");
    const cg = out.find((s) => s.name === "codegraph");
    expect(cg?.command).toBe("/pkg/codegraph");
    expect(cg?.args).toEqual(["serve", "--mcp"]);
  });

  it("skips injection when CODE_INTEL=off", () => {
    const out = injectDefaultServers([], { ...base, CODE_INTEL: "off" }, "linux");
    expect(out.find((s) => s.name === "codegraph")).toBeUndefined();
  });

  it("yields when user already configured a same-named server", () => {
    const user = parseMcpServers('{"mcpServers":{"codegraph":{"command":"my-cg","args":["x"]}}}');
    const out = injectDefaultServers(user, { ...base, CODE_INTEL: "codegraph" }, "linux");
    expect(out.filter((s) => s.name === "codegraph")).toHaveLength(1);
    expect(out.find((s) => s.name === "codegraph")?.command).toBe("my-cg");
  });

  it("yields when a differently-named user server exposes codegraph_* tools", () => {
    const user = parseMcpServers('{"mcpServers":{"my-cg":{"command":"x"}}}');
    const out = injectDefaultServers(
      user,
      { ...base, CODE_INTEL: "codegraph" },
      "linux",
      { "my-cg": ["codegraph_explore"] },
    );
    expect(out.find((s) => s.name === "codegraph")).toBeUndefined();
  });

  it("still injects open-websearch logic untouched", () => {
    const out = injectDefaultServers([], { ...base, CODE_INTEL: "off", OPEN_WEBSEARCH: "1" }, "linux");
    expect(out.find((s) => s.name === "open-websearch")).toBeTruthy();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run mcp/config.test.ts`
预期：FAIL（新增 describe 内断言失败 / 第 4 参数不被接受）。

- [ ] **步骤 3：编写最少实现代码**

在 `extensions/mcp/config.ts` 顶部 import：

```ts
import { getEngine, matchesEngineSignature } from "../code-intel/engines.js";
```

把 `injectDefaultServers` 改为（保留原 open-websearch 段，新增 code-intel 段；新增可选第 4 参 `userServerTools`）：

```ts
export function injectDefaultServers(
  servers: McpServerConfig[],
  env: Record<string, string | undefined>,
  platform: string,
  userServerTools: Record<string, string[]> = {},
): McpServerConfig[] {
  let out = servers;

  // 1) code-intel 引擎（默认 codegraph）。
  const engineName = env.CODE_INTEL ?? "codegraph";
  const engine = engineName === "off" ? undefined : getEngine(engineName);
  if (engine) {
    const sameName = out.some((s) => s.name === engine.serverName);
    const signatureHit = Object.entries(userServerTools).some(
      ([, tools]) => matchesEngineSignature(engineName, tools),
    );
    const pkgDir = env.PI_PACKAGE_DIR ?? "";
    if (!sameName && !signatureHit && pkgDir) {
      out = [...out, engine.buildConfig(pkgDir, platform)];
    }
  }

  // 2) open-websearch（原逻辑，保持不变）。
  if ((env.OPEN_WEBSEARCH ?? "0") !== "0" && !out.some((s) => s.name === "open-websearch")) {
    const isWin = platform === "win32";
    out = [
      ...out,
      {
        name: "open-websearch",
        transport: "stdio",
        command: isWin ? "cmd" : "npx",
        args: isWin ? ["/c", "npx", "-y", "open-websearch@latest"] : ["-y", "open-websearch@latest"],
        env: {
          MODE: "stdio",
          DEFAULT_SEARCH_ENGINE: env.OPEN_WEBSEARCH_ENGINE ?? "bing",
          ALLOWED_SEARCH_ENGINES: env.OPEN_WEBSEARCH_ENGINES ?? "bing,baidu,sogou,csdn,juejin",
        },
      },
    ];
  }

  return out;
}
```

注意：原实现里 open-websearch 段是「`if OPEN_WEBSEARCH==0 return servers`」提前返回；改写后两段独立、用 `out` 累积，行为对 open-websearch 等价（默认关、开时注入、同名跳过）。保留原注释。

- [ ] **步骤 4：更新 manager 的 `defaultReadServers` 传入用户工具映射**

修改 `extensions/mcp/manager.ts` 的 `defaultReadServers`：从 tools cache 读各 server 已知工具，传给 `injectDefaultServers` 第 4 参。

```ts
// manager.ts 顶部已 import getAllConfig/getConfig；新增：
import { readToolsCache } from "./toolsCache.js"; // 若不存在，复用 parseToolsCache + 读取函数

function defaultReadServers(): McpServerConfig[] {
  const userTools = readToolsCache(); // { [serverName]: string[] }，best-effort，缺省 {}
  const servers = injectDefaultServers(
    parseMcpServers(getConfig("MCP_SERVERS") ?? ""),
    getAllConfig(),
    process.platform,
    userTools,
  );
  return expandServerVars(servers, process.cwd());
}
```

若 `readToolsCache()` 尚不存在，新增到 `extensions/mcp/toolsCache.ts`：返回 `{}` 或解析已缓存的 `{server: {toolNames}}`。签名识别为「尽力而为」，缺数据时退化为仅同名判定（可接受）。

- [ ] **步骤 5：运行测试验证通过**

运行：`cd extensions && npx vitest run mcp/config.test.ts`
预期：PASS（含原有 + 新增）。

- [ ] **步骤 6：Commit**

```bash
git add extensions/mcp/config.ts extensions/mcp/config.test.ts extensions/mcp/manager.ts extensions/mcp/toolsCache.ts
git commit -m "feat(code-intel): inject active engine as default MCP with user-override yield"
```

---

## 任务 3：捆绑 codegraph 二进制（构建期）

**文件：**
- 创建：`tauri-agent/scripts/build-codegraph.mjs`
- 修改：`tauri-agent/package.json`
- 修改：`tauri-agent/src-tauri/tauri.conf.json`

- [ ] **步骤 1：tauri.conf.json 增加 externalBin**

修改 `tauri-agent/src-tauri/tauri.conf.json` 的 `bundle.externalBin`：

```json
"externalBin": ["binaries/pi", "binaries/codegraph"]
```

- [ ] **步骤 2：编写 build-codegraph.mjs**

参考现有 `scripts/build-sidecar.mjs` 的 triple 解析与 binaries 目录约定。脚本：取 rustc host triple → 把对应平台的 codegraph 自包含二进制放入 `src-tauri/binaries/codegraph-<triple>(.exe)`。版本用 `CODEGRAPH_VERSION` 常量 pin 住。

```js
// tauri-agent/scripts/build-codegraph.mjs
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const CODEGRAPH_VERSION = "1.0.0"; // pinned；升级时改这里

const appRoot = resolve(import.meta.dirname, "..");
const binDir = join(appRoot, "src-tauri", "binaries");
mkdirSync(binDir, { recursive: true });

const host = execSync("rustc -Vv").toString().split("\n").find((l) => l.startsWith("host:"));
if (!host) throw new Error("could not determine rustc host triple");
const triple = host.split("host:")[1].trim();
const isWin = triple.includes("windows");
const dest = join(binDir, `codegraph-${triple}${isWin ? ".exe" : ""}`);

if (existsSync(dest)) {
  console.log(`codegraph binary already present: ${dest}`);
} else {
  // 优先用 npm 安装的自包含二进制（@colbymchenry/codegraph 提供逐平台包）。
  // 安装到临时 prefix 后复制其 bin 到 dest。具体复制源依上游包结构而定（见 RUNBOOK）。
  console.log(`Fetching codegraph@${CODEGRAPH_VERSION} self-contained binary…`);
  execSync(`npm i -g @colbymchenry/codegraph@${CODEGRAPH_VERSION}`, { stdio: "inherit" });
  const which = isWin ? "where codegraph" : "command -v codegraph";
  const cgPath = execSync(which).toString().split("\n")[0].trim();
  execSync(isWin ? `copy "${cgPath}" "${dest}"` : `cp "${cgPath}" "${dest}"`, { stdio: "inherit", shell: true });
  if (!isWin) chmodSync(dest, 0o755);
}
console.log(`codegraph sidecar ready: ${dest}`);
```

注：上游复制源若非全自包含单文件（带运行时依赖），改为整目录拷入 `binaries/codegraph-runtime/` 并让命令指向其入口；该细节在执行时按上游实际产物核对并记录到 RUNBOOK。

- [ ] **步骤 3：package.json 增加脚本**

```json
"build:codegraph": "node scripts/build-codegraph.mjs"
```

- [ ] **步骤 4：本地验证二进制可跑**

运行（在 tauri-agent）：`npm run build:codegraph`
然后：`./src-tauri/binaries/codegraph-<triple> --version`
预期：打印版本号（确认自包含、可执行）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/scripts/build-codegraph.mjs tauri-agent/package.json tauri-agent/src-tauri/tauri.conf.json
git commit -m "build(code-intel): vendor self-contained codegraph binary as externalBin"
```

---

## 任务 4：Rust 索引命令（status/init/sync/reindex）

**文件：**
- 创建：`tauri-agent/src-tauri/src/commands/code_intel.rs`
- 修改：`tauri-agent/src-tauri/src/commands/mod.rs`
- 修改：`tauri-agent/src-tauri/src/lib.rs`

参考 `commands/mcp_policy.rs::probe_mcp_server` 的 `app.shell().sidecar(...)` 一次性 spawn 模式（codegraph 已在 externalBin，故 `sidecar("codegraph")` 可用）。命令在 workspace cwd 下运行 codegraph 子命令。

- [ ] **步骤 1：编写 code_intel.rs**

```rust
// tauri-agent/src-tauri/src/commands/code_intel.rs
use std::path::Path;
use tauri_plugin_shell::ShellExt;

async fn run_codegraph(
    app: &tauri::AppHandle,
    workspace: &str,
    args: &[&str],
) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("codegraph")
        .map_err(|e| format!("codegraph sidecar lookup failed: {e}"))?
        .current_dir(Path::new(workspace))
        .args(args)
        .output()
        .await
        .map_err(|e| format!("codegraph spawn failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "codegraph {:?} exited ({:?}): {}",
            args,
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 索引状态：`codegraph status`（人类可读文本，前端按行展示即可）。
#[tauri::command]
pub async fn code_intel_status(app: tauri::AppHandle, workspace: String) -> Result<String, String> {
    run_codegraph(&app, &workspace, &["status"]).await
}

/// 初始化并建索引（幂等：已存在 .codegraph 时 codegraph init 自身会处理）。
#[tauri::command]
pub async fn code_intel_init(app: tauri::AppHandle, workspace: String) -> Result<String, String> {
    run_codegraph(&app, &workspace, &["init"]).await
}

/// 增量同步。
#[tauri::command]
pub async fn code_intel_sync(app: tauri::AppHandle, workspace: String) -> Result<String, String> {
    run_codegraph(&app, &workspace, &["sync"]).await
}

/// 全量重建。
#[tauri::command]
pub async fn code_intel_reindex(app: tauri::AppHandle, workspace: String) -> Result<String, String> {
    run_codegraph(&app, &workspace, &["index", "--force"]).await
}

/// 是否已初始化（存在 .codegraph 目录）。
#[tauri::command]
pub async fn code_intel_is_initialized(workspace: String) -> Result<bool, String> {
    Ok(Path::new(&workspace).join(".codegraph").is_dir())
}
```

- [ ] **步骤 2：注册模块与命令**

`commands/mod.rs` 增加（按字母序，放在 `checkpoint` 后）：

```rust
pub mod code_intel;
```

`lib.rs` 的 `invoke_handler![...]` 增加：

```rust
            commands::code_intel::code_intel_status,
            commands::code_intel::code_intel_init,
            commands::code_intel::code_intel_sync,
            commands::code_intel::code_intel_reindex,
            commands::code_intel::code_intel_is_initialized,
```

- [ ] **步骤 3：编译验证**

运行（关闭正在运行的 app 后，在 tauri-agent/src-tauri）：`cargo check`
预期：通过（注意 OneDrive 路径需 app 未运行以释放二进制锁）。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/code_intel.rs tauri-agent/src-tauri/src/commands/mod.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(code-intel): rust one-shot status/init/sync/reindex commands"
```

---

## 任务 5：workspace 打开时自动 init

**文件：**
- 修改：`tauri-agent/src-tauri/src/commands/workspaces.rs`（或 `pi/manager.rs` 中 open_workspace 落点；执行时用 `codegraph_explore` 定位 `open_workspace` 实现）

- [ ] **步骤 1：在 open_workspace 成功后追加非阻塞自动 init**

定位 open_workspace 成功路径，在返回前 `spawn` 一个后台任务：当 `CODE_INTEL != off`、`CODE_INTEL_AUTO_INIT != 0`、且 `<workspace>/.codegraph` 不存在时，调用 `code_intel::code_intel_init`。失败仅日志，不阻塞打开。

```rust
// 伪定位：open_workspace 内、确认 workspace 有效后
let ws = workspace.clone();
let app2 = app.clone();
let cfg_off = std::env::var("CODE_INTEL").map(|v| v == "off").unwrap_or(false);
let auto = std::env::var("CODE_INTEL_AUTO_INIT").map(|v| v != "0").unwrap_or(true);
if !cfg_off && auto && !std::path::Path::new(&ws).join(".codegraph").is_dir() {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::commands::code_intel::code_intel_init(app2, ws).await {
            eprintln!("[code-intel] auto-init failed: {e}");
        }
    });
}
```

注：`CODE_INTEL` 在 Rust 侧的真实来源是 settings（写入 PI_RUNTIME_CONFIG 的 JSON / 进程 env）。执行时确认 open_workspace 能拿到 app handle 与 settings；若 settings 不在 env，则改读 settings store（与 `get_settings` 同源）。

- [ ] **步骤 2：编译验证**

运行：`cargo check`（app 未运行）。预期通过。

- [ ] **步骤 3：手动验证**

构建并启动 app（`npm run build:codegraph && npm run build:sidecar` 后 `npm run tauri dev`），打开一个未索引的项目目录，数秒后确认生成 `.codegraph/`，且 MCP 列表中出现 `codegraph` server 且工具非空。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/workspaces.rs
git commit -m "feat(code-intel): auto-init codegraph index on workspace open"
```

---

## 任务 6：前端 IO 薄层（供 Phase 3 复用）

**文件：**
- 创建：`tauri-agent/src/lib/codeIntelIo.ts`

- [ ] **步骤 1：编写包装**

```ts
// tauri-agent/src/lib/codeIntelIo.ts
import { invoke } from "@tauri-apps/api/core";

export function codeIntelStatus(workspace: string): Promise<string> {
  return invoke<string>("code_intel_status", { workspace });
}
export function codeIntelInit(workspace: string): Promise<string> {
  return invoke<string>("code_intel_init", { workspace });
}
export function codeIntelSync(workspace: string): Promise<string> {
  return invoke<string>("code_intel_sync", { workspace });
}
export function codeIntelReindex(workspace: string): Promise<string> {
  return invoke<string>("code_intel_reindex", { workspace });
}
export function codeIntelIsInitialized(workspace: string): Promise<boolean> {
  return invoke<boolean>("code_intel_is_initialized", { workspace });
}
```

- [ ] **步骤 2：typecheck**

运行（tauri-agent）：`npx tsc --noEmit`
预期：本文件无新增报错（既有 App.tsx/web-search 旧报错与本任务无关）。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/lib/codeIntelIo.ts
git commit -m "feat(code-intel): frontend invoke wrappers for index commands"
```

---

## 自检（规格覆盖 / 占位符 / 类型一致性）

- **规格覆盖（Spec 0+1）：** 引擎抽象（任务 1）、默认 MCP 注入 + 让位（任务 2）、离线捆绑（任务 3）、自动 init/同步命令（任务 4/5）、配置键 `CODE_INTEL`/`CODE_INTEL_AUTO_INIT`（任务 2/5 读取）。`CODE_INTEL_EXPLORER` 属 Phase 2；`CODEGRAPH_MCP_TOOLS` 透传留 Phase 3。引擎切换由 manager 既有 config-watch 覆盖（任务 2 修改 defaultReadServers 即生效，无需额外任务）。
- **占位符：** 任务 3 对「上游二进制是否单文件」留有执行期核对说明（非代码占位，是真实未知项，已给出两种处理路径）；任务 5 对 settings 来源留有核对说明。其余步骤均含可运行代码与命令。
- **类型一致性：** `McpServerConfig` 复用 `extensions/mcp/config.ts` 既有类型；`getEngine/matchesEngineSignature` 命名在任务 1 定义、任务 2 使用一致；Rust 命令名 `code_intel_*` 在 rs/lib.rs/前端三处一致。

## 风险与执行注意

- cargo / sidecar 构建需先关闭正在运行的 Hermes（OneDrive 路径 + 运行中二进制锁）。
- codegraph `status`/`init` 的确切 stdout 格式以执行期实测为准；前端先按纯文本展示，Phase 3 再结构化。
- 各 target triple 需各自跑 `build:codegraph` 产出对应二进制（CI 矩阵）。

## 后续计划（Phase 2 / 3 / 4）

- **Phase 2（Spec 2）· Context-Explorer 子代理：** 待 Phase 1 的引擎工具在 sidecar 内稳定后编写，复用 `multi-agent` capability + `explore_context` 工具。
- **Phase 3（Spec 3）· 管理 UI：** 待 Rust 命令（任务 4）落定后编写，ExtensionsPanel 第三 tab + `codeIntelIo`。
- **Phase 4 · GitNexus opt-in：** 准备/下载 + 互斥切换 + 增量能力。
- 这三份计划将各自走 writing-plans 同样流程，针对 Phase 1 的真实接口编写，避免推测性代码。
