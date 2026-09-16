# ast-index 可选代码智能引擎 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 把 [ast-index](https://github.com/defendend/Claude-ast-index-search)（纯 Rust 的 AST 代码搜索 CLI，单文件二进制 + `ast-index-mcp`）接入现有代码智能引擎抽象，作为 **CodeGraph 之外的可选引擎**；用户可在设置/UI 里把 `CODE_INTEL` 从 `codegraph` 切到 `astindex`，两引擎互斥可切换。默认仍是 `codegraph`，可随时回退。

**架构：** 复用既有引擎抽象（`extensions/code-intel/engines.ts` + `injectDefaultServers`）。新增 `astindex` 引擎条目（MCP 命令指向捆绑的 `ast-index-mcp`，经 env `AST_INDEX_BIN`/`AST_INDEX_ROOT=${workspaceFolder}` 定位）；新增 `build-astindex.mjs` 从 GitHub Releases 取每平台 `ast-index` 归档并准备 `ast-index-mcp`；把 Rust 侧一次性命令（status/init/sync/reindex/is_initialized）与 `open_workspace` 自动 init 改为**引擎感知**（按 `CODE_INTEL` 分派 codegraph / ast-index 子命令）。

**技术栈：** TypeScript（extensions sidecar）、Vitest、Rust（tauri commands）、Node 构建脚本（mirror `build-codegraph.mjs`）、tauri `bundle.resources`。

**对应规格：** `docs/superpowers/specs/2026-06-17-code-intelligence-builtin-design.md`（Spec 0 引擎抽象 / Spec 1 内置引擎 / Spec 3 管理 UI 的引擎感知扩展）。

---

## 范围与关键决策（用户确认）

- **定位：可选引擎，默认仍 CodeGraph。** ast-index 加入引擎注册表成为 `CODE_INTEL=astindex` 的一个选项；同一时刻只激活一个引擎（不双跑、不双索引），切换走 MCP manager 既有 config-watch 热生效。
- **「对话不自动索引」已单独处理**（本分支 `commands/agent.rs` 已加 `is_conversation_workspace` guard），本计划只需在改「引擎感知自动 init」时**保留**该 guard。
- **不动 CodeGraph 既有行为**：codegraph 仍是默认；本计划只新增 astindex 分支，不重构 codegraph 路径。
- **离线一致性**：ast-index 是单文件原生二进制（无 Node 运行时），比 codegraph 目录型 bundle 轻；捆绑方式与 codegraph 一致（fetch release + `bundle.resources`）。

### 与 CodeGraph 的关键差异（影响实现）

| 维度 | CodeGraph（默认） | ast-index（新增可选） |
| --- | --- | --- |
| 形态 | 目录 bundle（含 Node 24，数十 MB） | 单文件 `ast-index`（压缩 ~7.5MB）+ `ast-index-mcp` |
| 自动同步 | 引擎自带 file watcher | **无内置 watcher**，靠 `update` 子命令（需我们驱动） |
| MCP server | `codegraph serve --mcp --path <ws>` | `ast-index-mcp`（env `AST_INDEX_BIN` + `AST_INDEX_ROOT`） |
| 工具名 | `codegraph_*`（前缀可签名识别） | `search/symbol/class/...`（通用词，**不能**按前缀签名识别） |
| 索引落盘 | 项目内 `.codegraph/` | **缓存型 DB（项目外，按 project_root 键）** + 可选项目内 `.ast-index.yaml` 配置 |
| 子命令 | `init` / `index -f` / `sync` / `status` | `rebuild`（全量）/ `update`（增量）/ `stats` / `init` |

---

## Task 0：验证 spike（必须先做，决定后续分支，勿跳过）

这些是「跑一次就能定」的外部事实，必须在写捆绑/Rust 代码前确认，避免基于猜测实现。

- [ ] **V1：`ast-index-mcp` 是否在 release 归档里？**（决定捆绑方式）

下载并解压一个归档，列出内容：

```bash
cd $(mktemp -d)
curl -L -o a.zip https://github.com/defendend/Claude-ast-index-search/releases/download/v3.48.0/ast-index-v3.48.0-windows-x86_64.zip
tar -tf a.zip
# 同样查一个 unix 包：
curl -L -o a.tgz https://github.com/defendend/Claude-ast-index-search/releases/download/v3.48.0/ast-index-v3.48.0-linux-x86_64.tar.gz
tar -tzf a.tgz
```

预期分支：
- **若归档内含 `ast-index-mcp`(.exe)** → Task 2 直接 fetch 解压两者，最简单。
- **若仅含 `ast-index`(.exe)**（README 让用户 `cargo build -p ast-index-mcp`，很可能是此情况）→ Task 2 采用「fetch `ast-index` 二进制 + 从 pinned tag 源码 `cargo build --release -p ast-index-mcp`」。Tauri 构建链已有 Rust 工具链，可行；CI 矩阵各 runner 编译自身 target。

- [ ] **V2：确认 `ast-index-mcp` 的 stdio/env 契约与工具名。** 用 V1 拿到的二进制本地起一个 MCP 握手（或读 `docs/mcp-setup.md`）：

```bash
# 准备一个小项目并建索引
cd /path/to/sampleproj && /abs/ast-index rebuild
# 起 MCP server（env 指定 root 与 bin），发一条 initialize + tools/list（可用 mcp 客户端或手搓 JSON-RPC）
AST_INDEX_BIN=/abs/ast-index AST_INDEX_ROOT=/path/to/sampleproj /abs/ast-index-mcp
```

记录：工具名清单（应为 README 的 20 个：search/symbol/class/outline/usages/callers/call_tree/implementations/hierarchy/refs/imports/api/changed/module/deps/dependents/find_file/stats/rebuild/update）、是否真的读 `AST_INDEX_ROOT`、含空格路径是否安全。

- [ ] **V3：确认索引 DB 落盘位置（用于 is-initialized 判定）。** 在 sampleproj `rebuild` 后：

```bash
/abs/ast-index stats           # 看输出里是否含 DB 路径 / 符号数
# 找 DB（按 README 是缓存型，按 project_root 键）：
ls -la ~/.cache/ast-index 2>/dev/null; ls -la ~/Library/Caches/ast-index 2>/dev/null
```

记录：DB 绝对路径规则（决定 `code_intel_is_initialized` 的 astindex 分支用「`stats` 成功且符号>0」还是「DB 文件存在」）。**结论：优先用 `stats` 退出码 + 输出判定**，不依赖私有缓存路径。

> Task 0 三项跑完后，在本文件「实现纪要」段记录结论，再继续 Task 1+。

---

## 文件结构

- 修改 `extensions/code-intel/engines.ts` — 新增 `astindex` 引擎条目（serverName=`ast-index`，toolPrefix=`""`，buildConfig 指向捆绑 `ast-index-mcp` + env）。职责：纯元数据，无 I/O。
- 修改 `extensions/code-intel/engines.test.ts` — 加 astindex buildConfig 单测（含 env 字段、平台 ext）。
- 修改 `extensions/mcp/config.test.ts` — 加 `CODE_INTEL=astindex` 注入用例（注入 `ast-index` server、env 带占位符）。`injectDefaultServers` 本体**无需改**（已是引擎无关，读 `getEngine(CODE_INTEL)`）。
- 创建 `tauri-agent/scripts/build-astindex.mjs` — mirror `build-codegraph.mjs`：fetch 每平台 `ast-index` 归档（SHA256 校验）解压到 `src-tauri/binaries/ast-index/`；按 V1 结论附带/编译 `ast-index-mcp`。
- 修改 `tauri-agent/package.json` — 加 `build:astindex` 脚本。
- 修改 `tauri-agent/src-tauri/tauri.conf.json` — `bundle.resources` 增加 `binaries/ast-index/**/*`。
- 修改 `tauri-agent/src-tauri/src/commands/code_intel.rs` — 抽出引擎分派：新增 `enum Engine { CodeGraph, AstIndex }`，从 settings 读 `CODE_INTEL`；status/init/sync/reindex/is_initialized 各按引擎映射子命令与启动器。
- 修改 `tauri-agent/src-tauri/src/commands/agent.rs` — `open_workspace` 自动 init 改引擎感知（codegraph→`init`、astindex→`rebuild`；init-marker 判定引擎感知；**保留** `is_conversation_workspace` guard）。
- 修改 `tauri-agent/src/features/extensions/CodeIntelTab.tsx` — 引擎选择器增加 `ast-index` 选项；状态/按钮文案随引擎（同步→`update`、重建→`rebuild`）。
- 修改 `tauri-agent/src/features/extensions/CodeIntelTab.test.tsx` — 加 astindex 选项渲染/切换用例。
- （条件）修改探索子代理工具白名单/system prompt（若 Spec 2 已落地）— 工具集随引擎（codegraph_* ↔ ast-index 的 search/symbol/...）。Task 6 处理，先核实该代码是否存在。
- 修改 `docs/superpowers/specs/2026-06-17-code-intelligence-builtin-design.md` — 把 GitNexus 的「opt-in 高级引擎」描述补充/替换为 ast-index 现状（GitNexus 仍是未实现 stub）。

---

## Task 1：engines.ts 新增 astindex 引擎

**文件：**
- 修改：`extensions/code-intel/engines.ts`
- 测试：`extensions/code-intel/engines.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
// engines.test.ts 追加
import { getEngine } from "./engines.js";

describe("astindex engine", () => {
  it("builds an ast-index-mcp stdio config with bin/root env", () => {
    const eng = getEngine("astindex")!;
    expect(eng.serverName).toBe("ast-index");
    const cfg = eng.buildConfig("/pkg", "linux");
    expect(cfg.command).toBe("/pkg/ast-index/ast-index-mcp");
    expect(cfg.env?.AST_INDEX_BIN).toBe("/pkg/ast-index/ast-index");
    expect(cfg.env?.AST_INDEX_ROOT).toBe("${workspaceFolder}");
  });
  it("uses .exe suffix on win32", () => {
    const cfg = getEngine("astindex")!.buildConfig("/pkg", "win32");
    expect(cfg.command).toBe("/pkg/ast-index/ast-index-mcp.exe");
    expect(cfg.env?.AST_INDEX_BIN).toBe("/pkg/ast-index/ast-index.exe");
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`cd extensions && npx vitest run code-intel/engines.test.ts`
预期：FAIL（`getEngine("astindex")` 为 undefined）。

- [ ] **步骤 3：实现 astindex 条目**

在 `engines.ts` 的 `ENGINES` 里、`gitnexus` 之后加入（并加两个路径助手）：

```ts
function astIndexBin(pkgDir: string, base: "ast-index" | "ast-index-mcp", platform: string): string {
  const ext = platform === "win32" ? ".exe" : "";
  return `${pkgDir.replace(/[\\/]+$/, "")}/ast-index/${base}${ext}`;
}

const ENGINES: Record<string, CodeIntelEngine> = {
  // ...codegraph, gitnexus 不变...
  astindex: {
    serverName: "ast-index",
    // ast-index 的工具名是通用词（search/symbol/class…），按前缀签名识别会误伤其他 server，
    // 故置空：只做「同名 server 跳过」去重，不做签名识别（与 gitnexus stub 一致）。
    toolPrefix: "",
    buildConfig: (pkgDir, platform) => ({
      name: "ast-index",
      transport: "stdio",
      command: astIndexBin(pkgDir, "ast-index-mcp", platform),
      args: [],
      // AST_INDEX_ROOT 的 ${workspaceFolder} 由 expandServerVars 在 env 值上展开
      //（见 extensions/mcp/config.ts expandServerVars：对 env 逐值替换）。
      env: {
        AST_INDEX_BIN: astIndexBin(pkgDir, "ast-index", platform),
        AST_INDEX_ROOT: "${workspaceFolder}",
      },
    }),
  },
};
```

- [ ] **步骤 4：运行确认通过**

运行：`cd extensions && npx vitest run code-intel/engines.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add extensions/code-intel/engines.ts extensions/code-intel/engines.test.ts
git commit -m "feat(code-intel): register ast-index as optional engine"
```

---

## Task 2：捆绑脚本 build-astindex.mjs + tauri 资源

**文件：**
- 创建：`tauri-agent/scripts/build-astindex.mjs`
- 修改：`tauri-agent/package.json`
- 修改：`tauri-agent/src-tauri/tauri.conf.json`

- [ ] **步骤 1：写 build-astindex.mjs（mirror build-codegraph.mjs）**

整体复制 `tauri-agent/scripts/build-codegraph.mjs` 的 download/redirect/verifyChecksum/extract 骨架，改动点：

```js
const AST_INDEX_VERSION = process.env.AST_INDEX_VERSION || "3.48.0"; // pinned
const REPO = "defendend/Claude-ast-index-search";
const destDir = join(appRoot, "src-tauri", "binaries", "ast-index");

// release 资产命名：ast-index-v<V>-<os>-<arch>.<ext>
// 注意 arch 命名：x64→x86_64，arm64→arm64；win32 无 arm64 资产（见 Risks）。
const OS = { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform];
const ARCH = { x64: "x86_64", arm64: "arm64" }[process.arch];
const isWin = process.platform === "win32";
const asset = `ast-index-v${AST_INDEX_VERSION}-${OS}-${ARCH}${isWin ? ".zip" : ".tar.gz"}`;
const url = `${base}/v${AST_INDEX_VERSION}/${asset}`;
// 校验：release 每资产有 digest（GitHub API 提供）；可下 SHA256SUMS（若有）或用 API 的 digest。
// 解压：归档顶层是否有目录前缀以 V1 实测为准，决定是否 --strip-components=1。
```

`ast-index-mcp` 处理（按 V1 结论二选一）：
- **A（归档含 mcp）**：解压即得，确保可执行位（unix `chmod 0o755`）。
- **B（归档仅 ast-index）**：克隆 pinned tag 源码 `cargo build --release -p ast-index-mcp`，把产物 `target/release/ast-index-mcp(.exe)` 复制进 `destDir`：

```js
// B 分支
execSync(`git clone --depth 1 --branch v${AST_INDEX_VERSION} https://github.com/${REPO}.git ${srcDir}`, { stdio: "inherit" });
execSync(`cargo build --release -p ast-index-mcp`, { cwd: srcDir, stdio: "inherit" });
copyFileSync(join(srcDir, "target", "release", isWin ? "ast-index-mcp.exe" : "ast-index-mcp"), join(destDir, isWin ? "ast-index-mcp.exe" : "ast-index-mcp"));
```

smoke：`<destDir>/ast-index --version` 应打印 `3.48.0`；`<destDir>/ast-index-mcp` 能启动（起后立即关）。

- [ ] **步骤 2：package.json 加脚本**

```json
"build:astindex": "node scripts/build-astindex.mjs",
```

- [ ] **步骤 3：tauri.conf.json 加资源**

`bundle.resources` 数组里追加 `"binaries/ast-index/**/*"`（与现有 `"binaries/codegraph/**/*"` 并列；`externalBin` 不动）。

- [ ] **步骤 4：本机实跑验证**

运行：`cd tauri-agent && npm run build:astindex`
预期：`src-tauri/binaries/ast-index/` 下出现 `ast-index(.exe)` 与 `ast-index-mcp(.exe)`；smoke 打印版本。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/scripts/build-astindex.mjs tauri-agent/package.json tauri-agent/src-tauri/tauri.conf.json
git commit -m "build(code-intel): vendor ast-index binaries for bundling"
```

---

## Task 3：Rust 引擎感知（code_intel.rs）

**文件：**
- 修改：`tauri-agent/src-tauri/src/commands/code_intel.rs`

现状：`code_intel.rs` 把 codegraph launcher 与子命令硬编码。改为按 `CODE_INTEL` 分派。

- [ ] **步骤 1：加引擎枚举与解析**

```rust
#[derive(Clone, Copy, PartialEq)]
enum Engine { CodeGraph, AstIndex }

fn active_engine() -> Engine {
    // settings 经环境/настройки 透出；与 sidecar 读法一致（CODE_INTEL）。
    match std::env::var("CODE_INTEL").as_deref() {
        Ok("astindex") => Engine::AstIndex,
        _ => Engine::CodeGraph, // 默认 / off 时由调用方先判 off
    }
}
```

> 注：`CODE_INTEL` 的权威来源是 settings store（见 `app_state.rs settings_env`）。Rust 命令侧若拿不到进程 env，应改为参数传入或读 settings；实现时与 `code_intel_*` 调用链对齐（前端 `codeIntelIo` 可附带 engine 参数，避免 Rust 再读 settings）。**推荐：给每个 `code_intel_*` 命令加 `engine: String` 入参**，由前端从设置读出后传入，最简单且无歧义。

- [ ] **步骤 2：ast-index 启动器**

```rust
fn astindex_bin(app: &tauri::AppHandle) -> PathBuf {
    let dir = if let Ok(p) = app.path().resolve("binaries/ast-index", tauri::path::BaseDirectory::Resource) {
        if p.is_dir() { p } else { crate::pi::sidecar::pi_package_dir().join("ast-index") }
    } else { crate::pi::sidecar::pi_package_dir().join("ast-index") };
    let exe = if cfg!(windows) { "ast-index.exe" } else { "ast-index" };
    dir.join(exe)
}

// ast-index 子命令在 workspace 目录下运行（它从 cwd 检测/索引项目）。
async fn run_astindex(app: &tauri::AppHandle, workspace: &str, args: &[&str]) -> Result<String, String> {
    let bin = astindex_bin(app);
    let out = tokio::process::Command::new(&bin)
        .args(args)
        .current_dir(workspace) // 关键：ast-index 以 cwd 为项目根
        .output().await
        .map_err(|e| format!("ast-index spawn failed ({}): {e}", bin.display()))?;
    if !out.status.success() {
        return Err(format!("ast-index {:?} exited ({:?}): {}", args, out.status.code(), String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
```

- [ ] **步骤 3：各命令按引擎映射**

| 命令 | codegraph | ast-index |
| --- | --- | --- |
| `code_intel_status` | `status <ws>` | `stats`（cwd=ws） |
| `code_intel_init` | `init <ws>` | `rebuild`（cwd=ws，首次全量建索引） |
| `code_intel_sync` | `sync <ws>` | `update`（cwd=ws，增量） |
| `code_intel_reindex` | `index -f <ws>` | `rebuild`（cwd=ws） |
| `code_intel_is_initialized` | `.codegraph` 目录存在 | `stats` 成功且非空（见 V3） |

例（init）：

```rust
#[tauri::command]
pub async fn code_intel_init(app: tauri::AppHandle, workspace: String, engine: String) -> Result<String, String> {
    match engine.as_str() {
        "astindex" => run_astindex(&app, &workspace, &["rebuild"]).await,
        _ => run_codegraph(&app, &["init", workspace.as_str()]).await,
    }
}
```

`code_intel_is_initialized` 的 astindex 分支：

```rust
"astindex" => {
    // 无项目内标记目录；用 stats 退出码 + 是否报告已有索引判定。
    match run_astindex(&app, &workspace, &["stats"]).await {
        Ok(s) => Ok(!s.is_empty() && !s.to_lowercase().contains("no index")),
        Err(_) => Ok(false),
    }
}
```

- [ ] **步骤 4：编译验证**

运行：`cd tauri-agent/src-tauri && cargo check`
预期：0 error。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/code_intel.rs
git commit -m "feat(code-intel): make rust one-shot commands engine-aware (codegraph|astindex)"
```

---

## Task 4：open_workspace 自动 init 引擎感知（保留对话 guard）

**文件：**
- 修改：`tauri-agent/src-tauri/src/commands/agent.rs:166`（自动 init 段）

- [ ] **步骤 1：把硬编码 `.codegraph` 判定换成引擎感知**

```rust
// 读引擎（off 时整体跳过）
let engine = env.get("CODE_INTEL").map(String::as_str).unwrap_or("codegraph").to_string();
let auto_init = engine != "off"
    && env.get("CODE_INTEL_AUTO_INIT").map(|v| v.as_str() != "0").unwrap_or(true);

// ...spawn 成功之后：
// 保留对话 guard（本分支已加）；初始化标记按引擎判定。
if auto_init && !is_conversation_workspace(&cwd) {
    let already = match engine.as_str() {
        "astindex" => crate::commands::code_intel::code_intel_is_initialized(
            cwd.to_string_lossy().to_string(), "astindex".into()).await.unwrap_or(false),
        _ => cwd.join(".codegraph").is_dir(),
    };
    if !already {
        let app_for_init = app.clone();
        let ws_for_init = workspace.clone();
        let eng = engine.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = crate::commands::code_intel::code_intel_init(app_for_init, ws_for_init, eng).await {
                eprintln!("[code-intel] auto-init failed: {e}");
            }
        });
    }
}
```

> 现有 `auto_init_codegraph` 变量与 `code_intel_init(app, ws)` 两参调用需同步改为带 `engine` 三参（与 Task 3 签名一致）。

- [ ] **步骤 2：编译验证**

运行：`cd tauri-agent/src-tauri && cargo check`
预期：0 error。

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/agent.rs
git commit -m "feat(code-intel): engine-aware auto-init, keep conversation skip guard"
```

---

## Task 5：前端 IO + 管理 UI 引擎感知

**文件：**
- 修改：`tauri-agent/src/lib/codeIntelIo.ts`（命令带 `engine` 参数）
- 修改：`tauri-agent/src/features/extensions/CodeIntelTab.tsx`
- 修改：`tauri-agent/src/features/extensions/CodeIntelTab.test.tsx`

- [ ] **步骤 1：codeIntelIo 透传 engine**

`init/sync/reindex/status/isInitialized` 各加 `engine: string` 入参，invoke 时带上（与 Task 3 Rust 签名一致）。engine 从 settings 的 `CODE_INTEL` 读。

- [ ] **步骤 2：CodeIntelTab 加引擎选项 + 文案**

引擎选择器 options：`CodeGraph` / `ast-index` / `Off`（写 `CODE_INTEL`）。按当前引擎调整：
- 徽标：ast-index 显示「内置(bundled, native)」。
- 状态区按钮：codegraph「同步」→ ast-index「增量更新(update)」；「重建」两者都映射到各自全量。
- ast-index 无 watcher → 状态区加一句说明「ast-index 不自动监听文件，依赖手动/事件触发 update」。

- [ ] **步骤 3：测试**

`CodeIntelTab.test.tsx` 加：渲染含 ast-index 选项；选中后写 `CODE_INTEL=astindex`；mock 的 invoke 收到 `engine: "astindex"`。

运行：`cd tauri-agent && npx vitest run src/features/extensions/CodeIntelTab.test.tsx`
预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/lib/codeIntelIo.ts tauri-agent/src/features/extensions/CodeIntelTab.tsx tauri-agent/src/features/extensions/CodeIntelTab.test.tsx
git commit -m "feat(code-intel): engine selector + engine-aware management UI for ast-index"
```

---

## Task 6（条件）：探索子代理工具集随引擎

**前置核实：** 先确认 Spec 2 的探索子代理是否已落地（grep `explore_context` / `context-explorer` / capability 工具白名单）。**若尚未实现，跳过本 Task。**

- [ ] **步骤 1：** 若存在，把工具白名单与 system prompt 里硬编码的 `codegraph_explore/search/...` 改为「按当前引擎取工具集」：
  - codegraph → `codegraph_explore/search/callers/node/...`
  - astindex → `search/symbol/class/outline/usages/callers/call_tree/refs/...`（以 V2 实测工具名为准）
- [ ] **步骤 2：** 对应单测更新（引擎切换后白名单变化）。
- [ ] **步骤 3：Commit** `feat(code-intel): explorer subagent tool set follows active engine`。

---

## Task 7：更新设计规格文档

**文件：**
- 修改：`docs/superpowers/specs/2026-06-17-code-intelligence-builtin-design.md`

- [ ] 把「GitNexus = 可选高级引擎」一节标注为「未实现 stub」，并新增「ast-index = 轻量原生可选引擎」小节，记录：单文件二进制、无 watcher、缓存型 DB、工具集、捆绑方式、与 codegraph 互斥可切换。Commit `docs(code-intel): document ast-index optional engine`。

---

## 验证总览（全部任务后）

- `cd extensions && npx vitest run code-intel mcp`（引擎注册 + 注入用例）
- `cd tauri-agent && npx tsc --noEmit`（前端类型）
- `cd tauri-agent && npx vitest run src/features/extensions`（UI）
- `cd tauri-agent/src-tauri && cargo check`（Rust）
- `cd tauri-agent && npm run build:astindex` 后手测：设置切 `CODE_INTEL=astindex` → 打开一个真实项目 → 数秒后 `ast-index stats` 报告非空 → MCP 列表出现 `ast-index` server 且工具可用 → 打开一个「对话」目录确认**不**触发索引。

---

## 风险与权衡

- **`ast-index-mcp` 可能不在 release**（README 要 `cargo build -p ast-index-mcp`）：Task 0 V1 确认；若需源码编译，捆绑步骤变重（需 Rust 工具链 + 各 target 编译）。CI 矩阵各 runner 编译自身 target 可解。
- **Windows ARM64 无预编译资产**：release 只有 `windows-x86_64`。win-arm64 需源码编译或暂不支持（与 codegraph 平台矩阵对齐时注意）。
- **无内置 watcher**：ast-index 不自动同步。可接受现状（手动/UI 触发 `update`），或后续加「agent 编辑文件后/切 workspace 时触发 `update`」的事件驱动（独立增强，不在本计划内）。这与「少自动索引」诉求方向一致。
- **工具名通用词**：`search/symbol/class` 无法按前缀做「用户自配让位」签名识别；仅同名 server 去重（已在 engines 设计内接受）。
- **DB 体积**：ast-index DB 可达数百 MB（缓存目录），与 codegraph 量级相当；缓存型落盘不污染项目目录，反而更干净。
- **settings → Rust 的 engine 传递**：推荐前端读 `CODE_INTEL` 后作为命令入参传入（Task 3/5），避免 Rust 侧再读 settings 造成两处真值源不一致。

---

## 自检

- **规格覆盖：** 引擎注册（T1）、捆绑（T2）、Rust 引擎感知（T3）、自动 init + 对话 guard（T4）、UI（T5）、探索子代理（T6 条件）、文档（T7）。`CODE_INTEL=astindex` 端到端经 T1→T5 贯通。
- **占位符扫描：** Task 0 把外部不确定项收敛为「跑命令 + 分支」，非「待定」。Task 2 的 mcp 获取、Task 3 的 is_initialized 判定均给出可执行分支。
- **类型一致性：** `code_intel_*` 命令在 T3 加 `engine: String` 入参，T4（agent.rs 调用）与 T5（codeIntelIo invoke）均按此三参签名调用，一致。

---

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-06-18-ast-index-optional-engine.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新子代理，任务间审查（superpowers:subagent-driven-development）。
2. **内联执行** — 当前会话用 superpowers:executing-plans 批量执行 + 检查点。

建议先做 Task 0 三个 spike（确认 ast-index-mcp 来源 / 契约 / DB 判定），结论回填后再推 Task 1+。
