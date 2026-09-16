# 代码图谱引擎迁移：CodeGraph → codebase-memory-mcp 实现计划

> 状态：**已实施**（Phase 1/2/3 全部落地并验证：`cargo check` Finished、`tsc --noEmit` 0 错误、extensions vitest 678 passed、tauri-agent 受影响 vitest 全过、build 脚本 vendoring v0.8.1 OK）。Phase 0 索引 spike + Phase 0.5 MCP-模式 spike 均已通过；开放点 #1「多项目定位」已验证关闭。
>
> 实施补记：①「已索引」探针统一为 `stat(CBM_CACHE_DIR/<slug>.db)`，并修复 `agent.rs` 打开 workspace 自动 init 的 `.codegraph` 误判；② `sidecar.rs` 给 agent 进程注入 `CBM_CACHE_DIR`，与画布共用同一索引；③ 让位识别（前后端）改为签名工具 `search_graph`+`trace_path`；④ RichGraph 边类型按 `[:IMPORTS]`/`[:CALLS]` 分别查（`type(r)` 不支持）。待运行时验证：in-app dev 实跑 + release 完整打包。
>
> 决策（已确认）：**完全替换** codegraph（不并存）· **保留**代码图谱可视化标签页 · **spike 先行已通过**。
> 保留 multi-agent 的 **reviewer 子代理角色**（与本迁移无关）。
>
> 集成定调（spike 后锁定）：agent 路径用**客户端算 slug 并注入 `project=`**（不靠 cheap 模型自己猜，也无启动期绑定开关可用）；画布路径用 `cli query_graph` 按 `[:TYPE]` 分别取边。

## 目标

把 GrenAgent 内置的代码图谱引擎从 `colbymchenry/codegraph`（目录型 Node bundle）换成
`DeusData/codebase-memory-mcp`（单文件静态 C 二进制，158 语言，14 MCP 工具，自带语义搜索）。
对外行为保持：agent 仍有"预建索引 + 只读探索"，代码图谱画布 UI 不变。

## Phase 0 spike 结论（已验证，二进制 v0.8.1）

- 索引 `extensions/multi-agent`（21 文件）768ms → 231 节点 / 546 边。
- 画布所需数据全部可经 `cli query_graph` 产出（见下方"关键查询"）。
- 两个适配点：
  1. **Cypher 限制**：`WHERE` 只支持 `属性 <> 字面量`，不支持 `属性 <> 属性`。
     → "去自环 (a==b)" 放到 Rust 消费侧后过滤（codegraph 本就在消费侧过滤）。
  2. **外部导入**：`IMPORTS` 边目标若是 node_modules/外部包，其 `file_path` 为字面量 `"{}"`。
     → 过滤 `b.file_path <> '{}'`（字面量比较，Cypher 支持）。
- 存储在 `CBM_CACHE_DIR`（不在 `<ws>/.codegraph/`）；project 名是路径 slug，如
  `D-OneDrive-Project-Files-Pi-extensions-multi-agent`。

### 关键查询（Phase 2 用，已实测）

```text
# 文件→文件 import 边（消费侧再过滤 source==target 自环 + 空串路径）
query_graph {"project":"<slug>","query":
  "MATCH (a)-[:IMPORTS]->(b) WHERE b.file_path <> '{}'
   RETURN a.file_path AS source, b.file_path AS target, count(*) AS weight"}

# 文件→文件 call 边（RichGraph 第二类边；端点是 Function/Method，按 file_path 归并）
query_graph {"project":"<slug>","query":
  "MATCH (a)-[:CALLS]->(b) WHERE a.file_path <> '{}' AND b.file_path <> '{}'
   RETURN a.file_path AS source, b.file_path AS target, count(*) AS weight"}

# 每文件节点数（画布节点大小）— 注意结果含空串 file_path 行，消费侧需再滤掉
query_graph {"project":"<slug>","query":
  "MATCH (n) WHERE n.file_path <> '{}'
   RETURN n.file_path AS path, count(*) AS nodeCount"}

# 文件元信息（language 由 extension 推导）
query_graph {"project":"<slug>","query":
  "MATCH (f:File) RETURN f.file_path AS path, f.extension AS ext, f.change_count AS changes"}

# 索引状态 / 项目列表（管理 UI 用，输出为 JSON）
cli index_repository {"repo_path":"<abs ws>"}     # init / reindex（增量自动）
cli list_projects {}                               # {name,root_path,nodes,edges,size_bytes}
cli index_status {"project":"<slug>"}              # 状态
```

`get_graph_schema` 实测（v0.8.1 / multi-agent，231 节点 546 边）：
- **节点标签**：`Function(100) / Variable(28) / Method(24) / File(21) / Module(21) / Interface(12) / EnvVar(8) / Section(7) / Type(7) / Class(2) / Project(1)`。File 节点属性 = `name,qualified_name,file_path,start_line,end_line,change_count,extension,last_modified`。
- **边类型**：`DEFINES(201) / CALLS(191) / USAGE(49) / IMPORTS(34) / DEFINES_METHOD / CONTAINS_FILE / CONFIGURES / TESTS_FILE / WRITES / SEMANTICALLY_RELATED`。
  - ⚠ **只有单一 `IMPORTS`**，不区分 type-import / reexport / dynamic（codegraph 的 4 种 import 子类在此退化为一种）。文件级可用关系实际是 `IMPORTS` + `CALLS` 两类。
  - ⚠ **Cypher 不支持 `type(r)`**：`MATCH ()-[r]->() RETURN type(r)` 返回异常值（实测 `["546","546"]`）。要分边类型就得按 `[:IMPORTS]` / `[:CALLS]` **分别查**，不能用一条带 kind 列的查询。

---

## Phase 0.5 spike 结论：MCP 模式多项目定位（开放点 #1，已验证关闭）

用真二进制 v0.8.1 + 真索引 `extensions/multi-agent`，以 **MCP/stdio**（非 CLI）驱动 JSON-RPC 实测：

- **初始化**：无参启动 = MCP server（`main.c`：无参=MCP，`cli <tool> <json>`=一次性）。newline-delimited JSON-RPC；`initialize` → `notifications/initialized` 握手通过。
- **查询定位**：所有查询工具（`query_graph`/`search_graph`/`get_architecture`/...）handler 一律 `cbm_mcp_get_string_arg(args,"project")` → `resolve_store`，**`project` 缺失即 NULL → 直接报错，无 cwd/session 回退**。源码确认 `main.c` 永远 `cbm_mcp_server_new(NULL)` 启动，**无任何"锁单仓/cwd"的启动开关**（`store_path`/`set_project` 仅测试用）。即**无法复刻 codegraph 的 `--path`**。
- **slug 确定性可推导**（`cbm_project_name_from_path`，fqn.c）：

  ```text
  非 [A-Za-z0-9._-] 的字符 → '-'  ；  collapse 连续 '--' 与 '..'  ；  去首部 '-'/'.' 与尾部 '-'
  ```

  实测 `D:/OneDrive/Project Files/Pi/extensions/multi-agent` → `D-OneDrive-Project-Files-Pi-extensions-multi-agent`，与 `list_projects` 输出**逐字一致**。TS/Rust 均可零依赖复刻。
- **自纠兜底**：不带 `project` 调用回 `{"error":"project not found or not indexed","hint":"...","available_projects":["..."],"count":1}`——即便漏传，agent 也能据此重试。
- **结论**：开放点 #1 关闭。集成采用**客户端算 slug 注入 `project=`**（见 Phase 1 explorer.ts），可靠度等同 codegraph `--path`；`available_projects` 作二次兜底。

### spike 暴露的 gotcha（实施时注意）

1. **`type(r)` 不支持**（见上）——边类型按 `[:TYPE]` 分别查。
2. **空串 file_path**：node-count 查询会出现 `["",N]` 行（空路径，非 `'{}'`），Rust 侧除 `<> '{}'` 外还要滤空串。
3. **stdout/stderr 分离**：`level=info msg=...` 日志走 **stderr**，JSON 结果走 **stdout**。Phase 2 Rust `run_cbm` 只解析 stdout（CLI 模式同样：结果 JSON 是 stdout，别把日志混入）。
4. **版本号不一致**：`--version` 报 `0.8.1`，但 MCP `serverInfo.version` 报 `0.10.0`——让位/识别**别依赖版本号**，走工具名签名（如 `search_graph`+`trace_path` 存在）。另有一条无害 Windows stderr 报错（GBK"系统找不到指定的路径"，疑似 watcher/git，不影响查询结果）。

---

## 现状：codegraph 的两类消费方

| 消费方 | 文件 | 当前做法 |
|--------|------|----------|
| **A. agent 工具**（引擎抽象） | `extensions/code-intel/engines.ts`、`mcp/config.ts`、`code-intel/explorer.ts` | codegraph 以 MCP server 注入（`codegraph serve --mcp --path <ws>`）→ agent 得 `codegraph_*` 工具；explore_context 子代理优先用它 |
| **B. 画布 + 索引管理 UI** | `src-tauri/src/commands/code_intel.rs`、前端 `CodeGraphPanel/IndexPanel/CodeIntelTab/ansi.ts` | Rust 跑 codegraph CLI（init/status/sync/index）+ **直接只读 `.codegraph/codegraph.db`** 生成 `FileGraph`/`RichGraph` 喂画布 |

**关键差异（codebase-memory vs codegraph）**

| 维度 | codegraph | codebase-memory-mcp |
|------|-----------|---------------------|
| 形态 | 目录 bundle（Node 运行时 + lib + launcher，数十 MB） | **单文件静态二进制**（更易打包） |
| 工具名 | `codegraph_explore/search/callers/node/...`（统一前缀） | `search_graph/trace_path/query_graph/get_architecture/get_code_snippet/...`（**无统一前缀**） |
| 索引范围 | MCP 启动即 `--path <ws>` 锁定单工作区 | MCP 多项目；调用按 `project`/`repo_path` 参数定位 |
| 索引位置 | `<ws>/.codegraph/codegraph.db` | `CBM_CACHE_DIR`（默认 `~/.cache/...`），可选 `<ws>/.codebase-memory/graph.db.zst` 团队产物 |
| 状态输出 | ANSI 文本（`status`） | **JSON**（`list_projects`/`index_status`） |

---

## 配置键迁移

- `CODE_INTEL` 默认 `codegraph` → **`codebase-memory`**；旧值 `codegraph`/`gitnexus`/未知 → 回落 `codebase-memory`（避免迁移用户静默失效）。
- 引擎名常量 `codegraph` → `codebase-memory`（engines.ts / mcp/config.ts / codeIntelYield / CodeIntelTab）。
- 新增：`CBM_CACHE_DIR` 指向 app 可写数据目录（打包后不能用只读资源目录）；考虑开 `auto_index`。
- "已索引"判定：不再用 `existsSync(<ws>/.codegraph)`；首选 `stat(CBM_CACHE_DIR/<slug>.db)`（最便宜，slug 由 cwd 确定性算出），`list_projects` 作为兜底/管理 UI 用。

---

## Phase 1 — 打包二进制 + 引擎注入（agent 拿到工具）

| 文件 | 动作 |
|------|------|
| `tauri-agent/scripts/build-codebasememory.mjs` | **新建**（替代 build-codegraph.mjs）：从 `DeusData/codebase-memory-mcp` Releases 拉 pin 版本的**单文件**二进制（per-platform：`codebase-memory-mcp-{darwin,linux,windows}-{arm64,amd64}.{tar.gz,zip}`），校验 `checksums.txt`，解压出 `codebase-memory-mcp(.exe)` 到 `src-tauri/binaries/codebase-memory/`。比 codegraph 简单（无目录 bundle / 无 strip-components）。 |
| `tauri-agent/scripts/build-codegraph.mjs` | **删除** |
| `tauri-agent/package.json` | `build:codegraph` → `build:codebasememory`（指向新脚本） |
| `.github/workflows/release.yml` | CI 里 `build:codegraph` 步骤改名/重指 |
| `tauri-agent/src-tauri/tauri.conf.json` | `bundle.resources`：`binaries/codegraph/**/*` → `binaries/codebase-memory/**/*` |
| `extensions/code-intel/engines.ts` | 用 `codebase-memory` 引擎替换 `codegraph`：`serverName:"codebase-memory"`、`toolPrefix:""`（无前缀，签名识别改走已知工具名集合，见 Phase 3）、`buildConfig` = 单二进制 `command:<dir>/codebase-memory-mcp(.exe)`、`args:[]`、`cwd:"${workspaceFolder}"`（对齐 session 检测/auto-index，无空格截断问题，单二进制不需 codegraph 那套相对入口规避）、`env:{ CBM_CACHE_DIR }`。去掉 codegraph 的 win32 node.exe launcher 分支。注：查询用的 `project=<slug>` 不在此注入，而在 explorer.ts 客户端按 cwd 算出注入（见下）。 |
| `extensions/mcp/config.ts` | 默认引擎 `codegraph`→`codebase-memory`；二进制路径解析改单文件；不再注入 `--path ${workspaceFolder}`（codebase-memory 不吃该参数）；改注 `CBM_CACHE_DIR`，必要时启用 auto_index。 |
| `extensions/code-intel/explorer.ts` | ① 新增纯函数 `slugFromPath(cwd)`（复刻上述 4 步规范化），把 `project="<slug>"` **直接注入**探索任务/系统提示——cheap 模型零猜测（spike 已验证此路径）；② `EXPLORE_SYSTEM_PROMPT` 把 `codegraph_*` 指引换成 codebase-memory 工具（`search_graph`/`trace_path`/`get_code_snippet`/`query_graph`），并强调"所有调用带 `project=<上面给定的 slug>`；若回 `available_projects` 则从中取对应项重试"；③ 默认引擎 `codegraph`→`codebase-memory`；④ "已索引"判定从 `existsSync(.codegraph)` 改为 `stat(CBM_CACHE_DIR/<slug>.db)`；⑤ 工具 description 文案。 |
| `extensions/fable-behavior/prompts/tier2/tool-discipline.md` | `codegraph_*` → 新工具名 |

**验证（Phase 1）**：`engines.test.ts` 重写为 codebase-memory 引擎；手动：dev 下让 explore_context 跑，确认子代理拿到 codebase-memory 工具并能回答（先验证 project 定位/索引）。

> ✅ **集成点已 spike 验证（Phase 0.5）**：codebase-memory MCP 多项目、按参数定位，且**无启动期绑定开关**，故 **slug 注入是必须项**（不是可选）。客户端用 `ctx.cwd` 算出 slug 注入 `project=`，已实测查询命中；漏传时 server 回 `available_projects` 兜底。注意 agent 是只读的，**不索引**——索引依赖画布侧 `index_repository`（Phase 2）或显式开 `auto_index`（默认关）。

---

## Phase 2 — Rust 画布/管理重写（保持输出结构，前端零改）

`tauri-agent/src-tauri/src/commands/code_intel.rs` 重写：

- `codegraph_dir`/`launcher`/`run_codegraph` → 解析单二进制 + `run_cbm(app, ["cli", tool, json])`，设 `CBM_CACHE_DIR`。
- `code_intel_status` → `cli list_projects` / `index_status`（解析 JSON）。
- `code_intel_init` → `cli index_repository {"repo_path":<abs ws>}`。
- `code_intel_sync` → 同 `index_repository`（增量自动）。
- `code_intel_reindex` → `index_repository`（如有 force 选项则带上）。
- `code_intel_is_initialized` → 首选 `stat(CBM_CACHE_DIR/<slug>.db)`（slug 由 ws 路径确定性算出），`cli list_projects` 判 slug 在列作兜底（替代 `.codegraph/` 目录检查）。
- `open_codegraph_db` + `code_intel_file_graph` + `code_intel_rich_graph` → **不再直连 SQLite**；改为：
  1. 调 `cli query_graph`：`file_graph` 跑 import 边 + node_count + File 元信息；`rich_graph` **额外按 `[:TYPE]` 分别**跑 IMPORTS 边和 CALLS 边（`type(r)` 不支持，无法一条查询带 kind 列）；
  2. **只解析 stdout 的 `{columns,rows}` JSON**（日志在 stderr，须分离）；
  3. **Rust 侧后过滤**：`source==target` 自环 + **空串 file_path**（node-count 会混入 `["",N]`）；
  4. language 由 extension 映射（`.ts→typescript` 等）；node_count 由对应查询填充；
  5. 复用现有 `compute_layout`（420 步力导）→ **`FileGraph`/`RichGraph` 结构体完全不变** → 前端画布零改动。
  - ⚠ **边类型保真度下降**：`db_kind_to_edge_kind` 输入从 codegraph 的多种 import 子类塌缩为 **IMPORTS→`import-value`、CALLS→`call`** 两类（cbm 无 type-import/reexport/dynamic）。画布配色会变单调；如需更丰富可选映射 `USAGE`/`WRITES`/`CONFIGURES` 为新 kind（增量，非阻塞）。`circular_paths` 维持 `vec![]` 不变。

`tauri-agent/src/features/extensions/ansi.ts` `parseCodegraphStatus` → 改为解析 codebase-memory 的 **JSON** 状态（`list_projects` 的 `nodes/edges/size_bytes`），不再 regex-on-ANSI。`IndexPanel` 据此显示。

**验证（Phase 2）**：对一个已索引工作区调 `code_intel_file_graph`/`rich_graph`，断言节点/边非空且结构与旧一致；画布渲染正常（前端无改动即说明结构对齐）。

---

## Phase 3 — UI 文案 / 让位识别 / 收尾

| 文件 | 动作 |
|------|------|
| `tauri-agent/src/features/extensions/codeIntelYield.ts`（+test） | `CODEGRAPH_SERVER_NAME/PREFIX` → codebase-memory 的 serverName + 签名（因无前缀，改为检测已知工具名如 `search_graph`+`trace_path` 是否存在） |
| `tauri-agent/src/features/extensions/CodeIntelTab.tsx`（+test） | `ENGINE_OPTIONS` `codegraph`→`codebase-memory`；默认/回落值；文案"CodeGraph 内置/让位/无 .codegraph 自动 init" |
| `tauri-agent/src/features/chat/input/workspace/{CodeGraphPanel,WorkspaceBar,IndexPanel}.tsx` | 文案"CodeGraph"→引擎名（"代码图谱"作为功能名保留）；画布消费的数据结构不变 |
| `extensions/lsp/index.ts` | 核对并更新其 codegraph 引用（协调/让位） |
| `.gitignore` | 移除/调整 `.codegraph/`；如启用团队产物则加 `.codebase-memory/` |
| `docs/{architecture,development}.md`、release-notes、相关 specs | 更新描述（低优先，可批量） |

**验证（Phase 3）**：`codeIntelYield.test.ts`/`CodeIntelTab.test.tsx`/`ansi.test.ts` 改并通过；全量 `cd tauri-agent && npx tsc --noEmit` + 受影响 vitest；`cd extensions && npx vitest run code-intel/ mcp/`。

---

## 风险 / 开放问题

1. ~~**多项目定位**（最大未知）~~ → **已 spike 验证关闭**（见 Phase 0.5）：无启动期绑定开关，查询强制带 `project`；解法 = 客户端算 slug 注入 + `available_projects` 兜底。slug 确定性可复刻。
2. **打包数据目录**：`CBM_CACHE_DIR` 在打包 app 里必须是可写目录（不能是只读资源目录）；用 Tauri app data dir。
3. **平台二进制**：spike 仅验 windows-amd64；构建脚本要覆盖 mac/linux × arm64/amd64（codebase-memory 官方都有）。
4. **工具名变更面**：全仓 agent 指引/skill/prompt 里 `codegraph_*` 的引用都要切（fable-behavior、explorer prompt、可能的 SYSTEM/skill）。
5. **构建环境**：当前 `cargo`/`tauri` 构建被运行中的 GrenAgent 锁 `pi-*.exe` + OneDrive 阻；实施 Phase 2 验证前需关 app（且 OneDrive 暂停）。
6. **状态语义**：codegraph 的 sync/reindex 与 codebase-memory 的 auto-sync/index_repository 语义不完全一致；UI 文案与按钮需对齐新语义。

## 回滚

全程 git 可回滚；二进制经构建脚本可重新拉旧 codegraph。建议每个 Phase 单独 commit。

## 自检

- 覆盖：A（引擎注入：engines/mcp/config/explorer/prompt）+ B（Rust 画布/管理 + ansi + UI）两类消费方全部列出。
- spike 已证实画布数据可经 query_graph 产出（含 import/call 分类型查 + 三处适配：自环、空串、stdout）。
- Phase 0.5 MCP-模式 spike 已关闭"多项目定位"（slug 注入）。**仅剩"打包数据目录"（`CBM_CACHE_DIR` 指向 Tauri app data 可写目录）需在 Phase 1/2 实施时落实**，非阻塞。
