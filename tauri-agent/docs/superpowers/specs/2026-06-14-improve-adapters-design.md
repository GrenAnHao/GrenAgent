# improve 适配层设计规格 — 子代理模型 / worktree 隔离 / 只读边界

> **面向 AI 代理：** 这是设计规格（spec）。下一步用 `superpowers:writing-plans` 产出实现计划，再用 `superpowers:executing-plans` 内联执行（本仓库**禁止子代理**）。
>
> 配套计划：`docs/superpowers/plans/2026-06-14-improve-adapters-plan.md`。

**目标：** 为 GrenAgent（`pi` sidecar + `extensions/`）补齐三项底座能力，使其能内置并真正发挥 [`shadcn/improve`](https://github.com/shadcn/improve) 这类「审计 → 写计划 → 派廉价模型执行 → 审查」skill 的价值：

1. **子代理级模型指定** —— 单次委派可为每个子任务指定执行模型（贵模型规划、便宜模型执行）。
2. **worktree 隔离执行** —— 执行型子代理在 git worktree 中改文件，主工作区零污染，产出 diff 供审查。
3. **只读权限边界** —— 规划阶段子代理只读（或仅可写 `plans/`），杜绝便宜模型乱改源码。

**架构原则：** 三个适配点全部落在 `extensions/`（编译进 sidecar 二进制），**不改 `cli/src/main.ts` 的运行时装配**，**不改 Rust/Tauri 后端**。三者通过「工具参数 + 子进程 env 继承」协同——这正是 `extensions/multi-agent/runner.ts` 现有的子进程模型。

**技术栈：** TypeScript（Node ≥ 22）+ `@earendil-works/pi-coding-agent` 0.78.x ExtensionAPI + typebox + vitest（node 环境）。

---

## 1. 背景与动机

### 1.1 improve 需要的三个前提

`improve` 本身是纯 markdown 产物（计划写进 `plans/`），运行时无关，但要发挥设计价值，依赖宿主 agent 具备三种能力：

| improve 能力 | 依赖的宿主前提 |
|--------------|----------------|
| 「贵模型规划 + 便宜模型执行」 | 子代理能各自指定模型 |
| `/improve execute` 在隔离 worktree 跑、审查 diff | 子代理能在隔离目录执行并回收 diff |
| 「绝不改源码、只写 `plans/`」硬规则 | 能对子代理施加只读 / 写白名单边界 |

### 1.2 GrenAgent 现状（实测）

- **运行时：** `cli/src/main.ts` 用 `@earendil-works/pi-coding-agent` 0.78.0，RPC 模式自建 runtime 以支持 `skillsOverride` / `SKILLS_DISABLED`；其余模式（含子代理 `--mode json -p`）走官方 `main()`。已原生支持 **skill 系统**（前端 `commandTypes.ts` 的 `CommandApiSource` 含 `'skill'` 来源印证）。
- **子代理：** `extensions/multi-agent/index.ts` 注册 `spawn_agent` 工具，支持 `task`（单个）/ `tasks`（并行，`MAX_CONCURRENCY=4`）。底层 `runner.ts::spawnPiAgent` 以子进程跑 `pi --mode json -p --no-session [--model M] <task>`，子进程**继承父 env**（并强制关掉 KB/Memory/MCP 自动注入）。
- **安全：** `extensions/safety/index.ts` 用 `pi.on("tool_call")` 拦截 `bash`（危险命令确认）与 `write`/`edit`（受保护路径阻断），规则纯函数在 `rules.ts`，由 `SAFETY_BASH_CONFIRM` / `SAFETY_PROTECT_PATHS` 开关。`sandbox.ts` 的 `SandboxAdapter` 是预留接口。
- **快照：** `extensions/checkpoint/snapshot.ts` 用「影子 git 仓库」（独立 `--git-dir` + `--work-tree=cwd`，不碰用户 `.git`）实现每轮快照 / diff / revert，git helper（`gitArgs`/`ensureRepo`/`track`/`diff`/`restore`）可复用。
- **设置：** `tauri-agent/.../settingsSchema.ts` 把 env 映射成 GUI 字段；已有 `SUBAGENT_MODEL`、`SUBAGENT_TIMEOUT_MS`、`PI_BIN`、`SAFETY_BASH_CONFIRM`、`SAFETY_PROTECT_PATHS`。

### 1.3 关键缺口

| 适配点 | 已有 | 缺口 |
|--------|------|------|
| ① 模型 | `spawnPiAgent` 支持 `opts.model`→`--model`；`SUBAGENT_MODEL` 全局 env | `spawn_agent` 工具未暴露 / 未透传 `model`；无法 per-task 指定 |
| ② 隔离 | checkpoint 影子仓库 git helper | 子代理在主 `cwd` 直接改文件；无 worktree 隔离、无 diff 回收 |
| ③ 只读 | safety `tool_call` 拦截框架 + 受保护路径 | 无「只读」/「写白名单」模式；无法按子代理上下文收紧 |

---

## 2. 范围

### 2.1 三个适配点（本规格全部覆盖）

- **①** `extensions/multi-agent/`：`spawn_agent` 暴露并透传 per-task `model`。
- **②** `extensions/multi-agent/`：新增 `worktree.ts`，`spawn_agent` 增 `isolate` 参数，隔离执行 + 返回 diff。
- **③** `extensions/safety/`：新增「只读 / 写白名单」模式，env 驱动，可经子进程 env 透传给子代理。

### 2.2 非目标（YAGNI）

- 不实现 improve skill 本体（那是纯 markdown，按 `npx skills add` 或放入 skill 目录单独引入）。
- 不改 `cli/src/main.ts` 运行时装配、不改 Rust/Tauri 后端、不改 RPC 协议。
- 不做真正的 OS 级沙箱（`sandbox.ts` 仍是 Noop 预留）；③ 仅在工具层拦截。
- 不做子代理的嵌套隔离（worktree 内再 spawn 隔离子代理）。
- 不在本期引入新的「`execute_plan` / `review` 专用工具」——先用 `spawn_agent` 参数承载；如需独立工具留待后续。

---

## 3. 适配点①：子代理级模型指定

### 3.1 现状

`spawnPiAgent` 已完整支持模型（`extensions/multi-agent/runner.ts`）：

```ts
// runner.ts:71-79（节选）
export async function spawnPiAgent(cwd, task, opts: { model?: string; signal?; onUpdate? } = {}) {
  const args = [...baseArgs, "--mode", "json", "-p", "--no-session"];
  const model = opts.model ?? resolveSubagentModel();   // SUBAGENT_MODEL 兜底
  if (model) args.push("--model", model);
  args.push(task);
  ...
}
```

缺口仅在工具层：`spawn_agent` 的 `parameters` 没有 `model`，两处 `spawnPiAgent(...)` 调用（`index.ts:31`、`index.ts:53`）也没透传。

### 3.2 设计

工具参数升级为「单任务 + 可选模型」「并行任务（每项可带模型）」：

```ts
parameters: Type.Object({
  task: Type.Optional(Type.String()),
  model: Type.Optional(Type.String({ description: "Model for `task` (provider/id). Omit → SUBAGENT_MODEL or main default." })),
  tasks: Type.Optional(Type.Array(
    Type.Union([
      Type.String(),                                   // 旧形状：纯任务串，沿用默认模型
      Type.Object({ task: Type.String(), model: Type.Optional(Type.String()) }), // 新形状：task + 可选模型
    ]),
  )),
})
```

- 单任务：`spawnPiAgent(cwd, task, { model, ... })`。
- 并行：归一化为 `{ task, model }[]`，逐项把 `model` 透传给 `spawnPiAgent`。
- 优先级：`per-task model` > 工具级 `model`（仅对单任务）> `SUBAGENT_MODEL` env > 主代理默认。

### 3.3 决策

- **`tasks` 用 `Union[string, {task,model}]`** 而非全改对象数组：**向后兼容**现有调用方与前端 `taskLabel`（`subagentUtils.ts` 读 `args.task` / `args.tasks`，对纯串数组仍成立；对象数组需在 ③ 计划同步 `taskLabel`，见 plan T1.2 附带改动）。
- **不新增 `planner_model`**：规划模型＝主对话当前模型（improve 在主代理里跑），无需额外字段；只需让执行子代理走便宜模型即可。

---

## 4. 适配点②：worktree 隔离执行

### 4.1 现状

`spawn_agent` 的子代理全部在 `ctx.cwd`（主工作区）执行 —— 执行型任务会直接改用户文件。checkpoint 提供的是「事后影子快照」，非「执行前隔离」。

### 4.2 设计

新增 `extensions/multi-agent/worktree.ts`，封装原生 `git worktree`：

```ts
export interface Worktree { dir: string; branch: string; cleanup: () => Promise<void>; }
// gitWorktreeArgs(...) 纯函数（可单测）：构造 `git -C <repo> worktree add --detach <dir>` 等
export async function isGitRepo(cwd: string): Promise<boolean>
export async function createWorktree(cwd: string): Promise<Worktree | null>   // 失败/非 git → null
export async function worktreeDiff(repo: string, dir: string): Promise<string> // git diff (no index) of worktree
```

`spawn_agent` 增参 `isolate?: boolean`（默认 `false`）：

- `isolate=true` 且 `cwd` 是 git 仓库：`createWorktree` → 在 `wt.dir` 跑 `spawnPiAgent` → `worktreeDiff` 收 diff → `wt.cleanup()`（`git worktree remove --force`）。返回内容含子代理输出 **+ 统一 diff**（供主代理审查），主工作区不被改动。
- `isolate=true` 但非 git 仓库 / worktree 创建失败：**降级**——返回明确说明「无法隔离」，并按既有方式在 `cwd` 执行**或**拒绝（取决于 `ISOLATE_FALLBACK` 决策，见 4.3）。
- `isolate=false`：完全沿用现状（零行为变化）。

### 4.3 决策

- **用原生 `git worktree` 而非 checkpoint 影子仓库**：worktree 提供真正的独立工作目录（子进程 `cwd` 指过去即可），天然隔离；影子仓库是 overlay 在同一工作树上的，做不到目录隔离。但**复用 `snapshot.ts` 的 git argv 风格**（`-c core.autocrlf=false` 等 Windows 安全 flag）。
- **降级策略 = 拒绝并提示**（默认）：非 git 仓库时 `isolate=true` 返回错误「当前目录非 git 仓库，无法隔离执行；请改用非隔离模式或先 git init」，避免「以为隔离了其实在主目录改」的危险错觉。`ISOLATE_FALLBACK=1` 时才允许降级为非隔离执行。
- **worktree 落点：** 系统临时目录（`os.tmpdir()/grenagent-wt-<rand>`）而非项目内，避免被工具递归扫描 / 被 git 跟踪。
- **diff 范围：** worktree 内 `git add -A` 后 `git diff --cached`（含新增文件），与 checkpoint `track` 一致的口径。

---

## 5. 适配点③：只读权限边界

### 5.1 现状

`safety/index.ts` 已在 `tool_call` 钩子拦截 `bash`/`write`/`edit`，但只有「受保护敏感路径」黑名单，没有「整体只读」或「仅允许写某目录」的能力。

### 5.2 设计

**纯函数层（`rules.ts` 增）：**

```ts
// 路径是否落在某个白名单前缀内（规范化分隔符后前缀匹配）
export function matchWriteAllowed(path: string, allowlist: string[]): boolean
// bash 命令是否含写/改文件系统的意图（重定向 > / >>、rm、mv、cp、mkdir、tee、sed -i、git commit/checkout 等）
export function isMutatingBash(command: string): boolean
```

**钩子层（`index.ts` 增）：** 读两个 env

- `SAFETY_READONLY`（`1`/`true` 开）：开启「受限写」模式。
- `SAFETY_WRITE_ALLOW`（逗号分隔前缀，如 `plans/,docs/`）：白名单；为空表示「全只读」。

`tool_call` 逻辑（在现有受保护路径检查**之前/之外**叠加）：

```
若 SAFETY_READONLY:
  - write/edit：目标 path 不在 SAFETY_WRITE_ALLOW → block（reason: 只读模式，仅允许写 <allow>）
  - bash：isMutatingBash(command) → block（reason: 只读模式，禁止改动文件系统的命令）
  - 其余只读工具（read/grep/glob/web_*/...）放行
```

### 5.3 决策

- **env 驱动 + 子进程继承**：improve 规划子代理由主代理用 `spawn_agent(isolate=false)` + 环境收紧（`SAFETY_READONLY=1 SAFETY_WRITE_ALLOW=plans/`）启动；因 `spawnPiAgent` 子进程继承父 env，子代理内的 safety extension 自动生效。**注意**：这要求 `spawnPiAgent` 能按需注入这两个 env（见 plan T3.4：worktree/普通 spawn 时合并调用方指定的安全 env）。
- **「只读」是工具层软隔离，非沙箱**：恶意/越权命令仍可能绕过（如自定义工具）；定位为「防呆 + 约束便宜模型」，不是安全边界。`sandbox.ts` 留作未来真沙箱接入点。
- **白名单匹配规范化**：统一 `\\`→`/`、去 `./` 前缀、拒绝 `..` 逃逸（含 `..` 的路径一律视为不允许）。

---

## 6. 三者协同：improve 闭环

```
┌─ 主代理（贵模型，improve 顾问）────────────────────────────────┐
│  Recon / Audit / Vet / Prioritize / Plan                       │
│   └─ 可 spawn_agent({ tasks:[...], model: 便宜模型 })           │  ① 审计 fan-out 用便宜模型
│      并设 SAFETY_READONLY=1（审计只读）                          │  ③ 审计阶段只读
│   └─ 计划写入 plans/                                            │
│                                                                │
│  /improve execute 001                                          │
│   └─ spawn_agent({ task: "按 plans/001 实现", model: 便宜模型,  │  ① 执行用便宜模型
│                    isolate: true })                            │  ② worktree 隔离
│        └─ 子代理在 worktree 改文件 → 返回 diff                  │
│   └─ 主代理审查 diff（贵模型当 tech lead），合并由人决定         │
└────────────────────────────────────────────────────────────────┘
```

- **①** 决定「谁用哪个模型」。
- **②** 决定「执行在哪改、改了什么（diff）」。
- **③** 决定「规划阶段不许改、执行阶段只在 worktree 改」。

三者独立可用、组合成闭环；任一单独落地都有增量价值（故计划按 P1→P2→P3 分阶段，互不阻塞）。

---

## 7. 数据流

```
spawn_agent(params)
  ├─ 归一化 tasks → {task, model}[]                       (①)
  ├─ isolate? → createWorktree(cwd) → wtDir              (②)
  ├─ spawnPiAgent(wtDir ?? cwd, task, { model, env: {SAFETY_READONLY?, SAFETY_WRITE_ALLOW?} })
  │     └─ 子进程: pi --mode json -p --no-session --model M <task>
  │           └─ safety extension 读 env → 拦截写/改命令   (③)
  ├─ isolate? → worktreeDiff() 收 diff → cleanup()        (②)
  └─ 返回 { output, transcript, diff? }
```

---

## 8. 错误处理与边界

| 场景 | 处理 |
|------|------|
| `isolate=true` 但非 git 仓库 | 默认拒绝并提示；`ISOLATE_FALLBACK=1` 时降级为非隔离 |
| worktree 创建成功但执行中崩溃 | `finally` 中 `wt.cleanup()`，不残留 worktree |
| `git worktree remove` 失败 | 记录 stderr，尽力 `--force`；不抛出（隔离产物清理失败不应让主任务失败） |
| `model` 给了无效串 | 透传给 `pi --model`，由 pi 报错并经子代理 `exitCode≠0` 冒泡（既有路径） |
| `SAFETY_WRITE_ALLOW` 含 `..` | 规范化后拒绝匹配（视为不允许） |
| `tasks` 同时给对象与串混合 | 归一化函数统一成 `{task, model?}`；空 task 跳过（沿用现有 filter(Boolean)） |
| readonly 误伤合法写 | 文案明确「只读模式 + 当前白名单」，便于主代理调整 env 或关 readonly |
| 旧调用方（无新参数） | 全部可选，默认行为 100% 不变（向后兼容） |

---

## 9. 实现顺序

| 阶段 | 适配点 | 依赖 | 价值（单独可用） |
|------|--------|------|------------------|
| **P1** | ① 模型 | 无 | improve 审计/执行可用便宜模型，立即省成本 |
| **P2** | ② 隔离 | 无（与 P1 正交） | execute 安全隔离 + diff 审查 |
| **P3** | ③ 只读 | 无（与 P1/P2 正交） | 规划阶段防改源码；配合 ① 收紧子代理 |

三阶段无强依赖，可按 P1→P2→P3 顺序内联实现，每阶段独立可合并、可验证。

---

## 10. 决策记录

| 决策 | 选项 | 结论 | 理由 |
|------|------|------|------|
| 改动落点 | 改 cli runtime / 仅改 extensions | **仅 extensions** | 编译进二进制即可，零运行时装配改动、零后端改动 |
| `tasks` 形状 | 全对象数组 / Union 兼容 | **Union[string, {task,model}]** | 向后兼容现有调用方与前端 taskLabel |
| 隔离机制 | checkpoint 影子仓 / 原生 worktree | **worktree** | 真目录隔离；复用 snapshot 的 Windows 安全 git flag |
| 非 git 时 isolate | 静默降级 / 拒绝 | **默认拒绝**（env 可放开） | 杜绝「以为隔离实则改主目录」 |
| 只读实现层 | OS 沙箱 / 工具层拦截 | **工具层（safety 钩子）** | 复用现有 tool_call 框架；沙箱留预留接口 |
| 权限传递 | 进程参数 / env 继承 | **env 继承** | 与 runner 现有 env 模型一致，子代理自动生效 |

---

## 11. 相关文件（现状）

- `extensions/multi-agent/index.ts` — `spawn_agent` 工具（①② 改） 
- `extensions/multi-agent/runner.ts` — `spawnPiAgent`（① 已支持 model；②③ 需透传 env） 
- `extensions/multi-agent/runner.test.ts` — 测试风格参考
- `extensions/safety/index.ts` — `tool_call` 拦截（③ 改）
- `extensions/safety/rules.ts` — 规则纯函数（③ 增）
- `extensions/safety/rules.test.ts` — 测试参考
- `extensions/checkpoint/snapshot.ts` — git helper 风格参考（② 复用思路）
- `tauri-agent/src/features/settings/settingsSchema.ts` — GUI 设置字段（①③ 增字段）
- `tauri-agent/src/features/panels/subagentUtils.ts` — `taskLabel`（① tasks 对象化时同步）
- `cli/src/main.ts` — sidecar 装配（**不改**，仅理解 skill/runtime）

---

**状态：** 设计待定稿。下一步 → `writing-plans` 产出 `2026-06-14-improve-adapters-plan.md`（已配套生成）。
