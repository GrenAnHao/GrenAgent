# 融合子代理系统设计 — 可控 / 高效 / 安全（能力可拼配）

- 日期：2026-06-15
- 状态：架构蓝图（待审）
- 主题：把 Pi 现有「一次性子进程子代理」演进为一套**分层、能力模块化可拼配**的子代理系统，融合三家之长：Pi（轻量子进程 + env 隔离）、MiMo-Code（有状态 actor + 注册表 + 完成门控 + 互通）、Cursor（强专精 + 强隔离 + 并行编排）。
- 落地约束：全部改动落在 `extensions/`（编译进 sidecar），**不改 `cli/src/main.ts` 运行时装配、不改 Rust/Tauri 后端、不改 RPC 协议**（沿用 `2026-06-14-improve-adapters-design.md` 的架构原则）。
- 关联：`extensions/multi-agent/`、`extensions/safety/`、`extensions/checkpoint/`、`extensions/_shared/`、`tauri-agent/src/features/panels/`、`tauri-agent/src/features/dock/`、`tauri-agent/src/features/settings/settingsSchema.ts`、前序 spec `2026-06-14-improve-adapters-design.md`。

---

## 1. 目标与范围

### 1.1 总体目标

用户诉求原话：「融合出无敌的子代理系统 —— 可控、高效、安全，我全都要；可模块化拼配控制子代理的能力（只读 / 工作 等等），可扩展可缩减。」

拆成三个支柱 + 一个贯穿主线：

| 支柱 | 含义 | 主要融合来源 |
|------|------|--------------|
| **可控** | 能查状态 / 等待 / 取消 / 绑定任务 / 完成把关，子代理不失控、不黑盒 | MiMo-Code |
| **高效** | 并行、轻量、上下文隔离只回结论、默认零额外开销 | Cursor + Pi |
| **安全** | 隔离执行、最小权限、只读边界、写白名单、危险操作审批 | 三家 + Pi safety |
| **主线：能力可拼配** | 子代理「能做什么」由一份可组合、可增减的**能力档案**声明 | 本设计原创（统一现有散落开关） |

### 1.2 设计哲学：用「分层 + 默认最轻 + 能力档案」化解三者张力

「可控 / 高效 / 安全」存在天然张力：强控制=重，强隔离=慢，强协作=复杂。**不可能让每个子代理同时背上全部成本**。

解法 = 三条：

1. **能力档案（Capability Profile）** —— 把「模型 / 隔离级别 / 文件系统权限 / 工具白名单 / 联网 / MCP / 可否再 spawn / 资源配额」统一成一份可组合的声明，像拼积木一样增减。这是「可拼配、可扩展可缩减」的落点。
2. **分层按需** —— 隔离与控制都分档，任务**按它声明的能力自动选最轻的一档**；只有写操作 / 高危才升级到重隔离。
3. **向后兼容** —— 现有 `spawn_agent({task})` 调用零行为变化；新能力全部走可选字段，旧前端（`SubAgentInline` / `taskLabel`）仍成立。

### 1.3 不在范围内（YAGNI）

- 不改 `cli/src/main.ts` 运行时装配、不改 Rust/Tauri 后端、不改 RPC 协议。
- 不要求 Pi 核心支持「同进程内子代理（in-process）」；Pi 子代理的最轻形态仍是**子进程**。
- 不在早期阶段做 actor 间双向通信（inbox）；先做单向委派 + 后台回收。P4 再评估。
- 不做真正的 OS 沙箱实现（`safety/sandbox.ts` 仍是预留接口，P4 再落地）。
- 不强制把所有内置能力扩展（web/memory/kb…）改造成 capability 感知；先覆盖子代理 spawn 路径。

---

## 2. 现状基线（实地核对 2026-06-15）

### 2.1 Pi 子代理现状

- **入口**：`extensions/multi-agent/index.ts` 注册 `spawn_agent`，支持 `task`（单个）/ `tasks`（并行，`MAX_CONCURRENCY=4` 硬编码），已支持 per-task `model`（improve ① 已落地）。
- **执行**：`runner.ts::spawnPiAgent` 以子进程跑 `pi --mode json -p --no-session [--model M] <task>`；`stdio:["ignore","pipe","pipe"]`；继承父 env 但强制关 `KB_AUTO_INJECT` / `MEMORY_AUTO_INJECT` / `MEMORY_AUTO_CAPTURE` / `MEMORY_EXTRACT` / `MCP_SERVERS`。
- **控制**：超时 `SUBAGENT_TIMEOUT_MS`（默认 120s）到点 `child.kill()`；`AbortSignal` → kill。**无状态、无 status/wait/cancel、无后台、无注册表、跑完即弃。**
- **前端**：`SubAgentInline`（流内可折叠）+ 右侧 Dock 每任务一 tab（`dockStore.syncSubAgentTabs`）+ `SubAgentConversation`（JSONL 还原气泡）。

### 2.2 improve-adapters 三块落地状态

| 适配点 | spec 设计 | 实际落地 |
|--------|-----------|----------|
| ① per-task model | 已设计 | **已落地**（`spawn_agent` 有 `model`） |
| ② worktree 隔离 + diff | 已设计（`worktree.ts` + `isolate` 参数） | **未落地**（无 `worktree.ts`，无 `isolate`） |
| ③ 只读 / 写白名单 | 已设计（`SAFETY_READONLY` / `SAFETY_WRITE_ALLOW`） | **未落地**（`safety/index.ts` 仅危险 bash + 受保护路径） |

### 2.3 可复用资产（关键）

| 资产 | 位置 | 在本设计的用途 |
|------|------|----------------|
| safety `tool_call` 拦截框架 | `extensions/safety/index.ts` + `rules.ts` | 只读 / 写白名单 / 工具黑名单的强制点 |
| 影子 git 快照 / diff / revert | `extensions/checkpoint/snapshot.ts` | worktree 隔离复用其 Windows 安全 git argv 风格；diff 回收 |
| 预留沙箱接口 | `extensions/safety/sandbox.ts`（Noop） | P4 OS 沙箱落点 |
| SQLite 封装 | `extensions/_shared/sqlite.ts` | 子代理注册表持久化（status/wait/cancel） |
| 运行时配置热更新 | `extensions/_shared/runtime-config.ts`（`getConfig`/`watchConfig`） | 能力档案 / 配额 / 开关读取 + 热更新 |
| MCP 策略 | `extensions/mcp-policy/` | 子代理 MCP 能力位的策略参考 |
| 子代理 UI | `tauri-agent/src/features/panels` + `features/dock` | 展示状态 / 档案 / 控制按钮 |

---

## 3. 核心抽象：能力档案 CapabilityProfile（可拼配主线）

把当前散落在 env 与工具参数里的开关（`model` / 未来的 `isolate` / `SAFETY_READONLY` / `SAFETY_WRITE_ALLOW` / 工具集 / MCP）**统一收编**成一份声明式、可组合、可增减的能力档案。

### 3.1 数据结构（提议）

```ts
// extensions/multi-agent/capability.ts （新增）
export interface CapabilityProfile {
  /** 档案名（预设名或用户自定义名），用于 UI 展示与 spawn 时按名拼配 */
  name?: string;

  /** 工具能力：白名单优先；deny 在 allow 之后再剔除（模块化拼配核心） */
  tools?: { allow?: string[]; deny?: string[] };

  /** 文件系统能力档：只读 / 全工作区 / 仅白名单可写 */
  fs?: "readonly" | "workspace" | { writeAllow: string[] };

  /** 联网能力：是否允许 web_search / web_fetch / web_crawler */
  net?: boolean;

  /** MCP 能力：false 全关（默认）/ true 全开 / 字符串数组=服务白名单 */
  mcp?: boolean | string[];

  /** 是否允许该子代理再 spawn 子代理（默认 false，防递归爆炸） */
  spawn?: boolean;

  /** 隔离档（分层按需，见 §4）；省略=按 fs 能力自动选最轻 */
  isolation?: "process" | "worktree" | "sandbox";

  /** 模型档（provider/id 或别名 cheap/strong），省略→SUBAGENT_MODEL→主默认 */
  model?: string;

  /** 资源配额 */
  limits?: { timeoutMs?: number; maxConcurrency?: number; tokenBudget?: number };
}
```

### 3.2 预设档案（开箱即用，用户可覆盖 / 扩展）

| 档案 | fs | net | tools | isolation | model | 典型用途 |
|------|----|----|-------|-----------|-------|----------|
| `explore` | readonly | true | 只读类 + 搜索 | process | cheap | 只读探索 / 调研（对齐 Cursor explore） |
| `planner` | `{writeAllow:["plans/","docs/"]}` | true | 读 + 写 plans | process | strong | 规划，只许写计划目录（improve ③ 场景） |
| `executor` | workspace | false | 全量 | worktree | cheap | 按计划改代码，worktree 隔离 + 回收 diff（improve ②） |
| `reviewer` | readonly | false | 只读 + git diff | process | strong | 独立审查实现 vs 规格 |
| `default` | workspace | true | 继承主 | process | 主默认 | 向后兼容（= 今天的 `spawn_agent`） |

### 3.3 拼配语义（增 / 减 / 覆盖）

`spawn_agent` 增加可选 `profile` 字段，三种用法可叠加：

```jsonc
// 1) 按预设名一键拼配
{ "task": "...", "profile": "explore" }

// 2) 预设 + 局部覆盖（在 explore 基础上额外允许写 notes/）
{ "task": "...", "profile": { "extends": "explore", "fs": { "writeAllow": ["notes/"] } } }

// 3) 纯内联拼配（完全自定义，能力可增可减）
{ "task": "...", "profile": { "fs": "readonly", "net": false, "tools": { "deny": ["bash"] }, "model": "cheap" } }
```

- **解析顺序**：内联字段 > `extends` 的预设 > `default`。
- **用户自定义档案来源**：`.pi/subagents/*.json`（或 `.md` front-matter），由 `getAllConfig` 同源加载；GUI 设置里也可维护。`name` 唯一即可被 `profile: "<name>"` 引用。
- **可扩展可缩减**：能力位都是可选；给了就生效，不给就走更轻的默认。新增一类能力位（例如未来的 `gpu`）只需加一个字段，不破坏旧档案。

### 3.4 能力如何强制（profile → 子进程）

能力档案在 `spawnPiAgent` 处翻译成「子进程 env + cwd + 工具门」：

```
profile.fs=readonly        → env SAFETY_READONLY=1, SAFETY_WRITE_ALLOW=""        (safety 拦截 write/edit/mutating bash)
profile.fs={writeAllow}    → env SAFETY_READONLY=1, SAFETY_WRITE_ALLOW="plans/"  (白名单外写入 block)
profile.fs=workspace       → 不设 readonly（可写主/隔离目录）
profile.net=false          → env 关闭 web_* 工具（safety 工具黑名单 or 不注册）
profile.mcp=false          → env MCP_SERVERS=""（现状默认即此）
profile.mcp=[...]          → env MCP_SERVERS=白名单
profile.spawn=false        → env 不加载 multi-agent 扩展 / 工具黑名单 spawn_agent（防递归）
profile.tools.{allow,deny} → env 传递工具门清单，safety tool_call 统一裁决
profile.isolation=worktree → createWorktree(cwd) → 子进程 cwd 指向 worktree，回收 diff
profile.model              → --model 解析（cheap/strong 别名 → 实际 provider/id）
profile.limits             → 覆盖 SUBAGENT_TIMEOUT_MS / 并发 / token 预算
```

子进程仍然**继承父 env**（provider key 等），能力档案只做**收紧 / 选择**，不放权 —— 安全默认。

---

## 4. 分层隔离（Isolation Tiers）

隔离是 capability 的一个维度，分三档，**默认按 fs 能力自动选最轻**：

| 档 | 机制 | 写隔离 | 成本 | 触发 |
|----|------|--------|------|------|
| `process`（默认） | 独立子进程 + env 收紧（现状） | 无（共享 cwd） | 低 | 只读 / 受限工具任务自动用此 |
| `worktree` | 子进程 cwd 指向 `git worktree` 独立目录 | 有（主工作区零污染）+ 回收 diff | 中 | `fs=workspace` 且任务会写时升级 |
| `sandbox` | 子进程 + OS 沙箱（`sandbox.ts` 落地） | 强（fs + 网络 + syscall） | 高 | 不可信 / 高危任务显式声明（P4） |

**自动选档规则**：`isolation` 省略时——`fs=readonly` → `process`；`fs=workspace` 且非显式信任 → `worktree`；显式 `isolation` 覆盖自动选择。

「分层按需」即体现于此：默认轻（process），写才升 worktree，高危才 sandbox。

---

## 5. 统一控制面（从「一次性」到「可控」）

### 5.1 工具动作

`spawn_agent` 升级为统一子代理工具（保留旧入参形态）。新增动作走可选 `action` 字段，缺省 `action` = 现状的「同步委派」：

| action | 语义 | 阶段 |
|--------|------|------|
| 缺省 / `run` | 同步委派，阻塞返回结果（含 transcript / diff） | 现状 + 增 profile |
| `spawn` | 后台委派，立即返回 `agentId`，完成写回注册表 + 通知 | P3 |
| `status` | 查某子代理状态（不阻塞） | P3 |
| `wait` | 阻塞等某后台子代理完成 / 超时 | P3 |
| `cancel` | 终止某子代理（kill 子进程，幂等） | P3 |

### 5.2 子代理注册表（可控核心，P3）

用 `_shared/sqlite.ts` 持久化每个子代理：

```
subagent(id, task, profile_json, status, child_pid, model, started_at,
         updated_at, completed_at, exit_code, transcript, diff, error)
status ∈ pending | running | done | error | cancelled
```

- `spawn`（后台）= 起子进程、记 pid、`status=running`、不阻塞；child 完成时写回 + 经 IM/通知告知主代理。
- `status`/`wait` 读注册表；`cancel` 按 pid `child.kill()` + 标 `cancelled`。
- **孤儿恢复**（借鉴 MiMo）：扩展启动时把残留 `running` 标 `error: orphaned`。
- **卡死检测**：可选定时扫描超 N 分钟无更新的 running，提示 / 自动超时。

这一步把 Pi 子代理从「一次性子进程」升级为「有状态、可查询、可中止、可后台」——「可控」支柱主要在此落地。

---

## 6. 安全门（安全支柱）

分三层纵深，全部复用 / 扩展现有 safety：

1. **spawn 前校验**：按 profile 解析能力，拒绝越权组合（如 `executor` 要求 worktree 但非 git 仓库 → 默认拒绝并提示，沿用 improve ② 决策）。
2. **运行时工具门（`safety/index.ts` 扩展）**：子进程内 safety 扩展按 env（`SAFETY_READONLY` / `SAFETY_WRITE_ALLOW` / 工具黑名单 / 危险 bash）逐工具裁决（improve ③）。
3. **危险操作审批**：高危动作经插件 `request_approval`（Pi 已有 UI 通道）人工确认；无 UI 场景 fail-safe block（沿用 `ctx.hasUI` 现有处理）。

`rules.ts` 需新增纯函数（可单测）：`matchWriteAllowed(path, allowlist)`、`isMutatingBash(command)`、`toolGate(toolName, profile)`。

---

## 7. 可观测与健壮性

| 能力 | 实现 | 来源 |
|------|------|------|
| 实时 transcript | 现有 `onUpdate` 流式 + JSONL | Pi 现状 |
| 状态可视 | `SubAgentInline` 增 profile 徽标 + 状态色；Dock tab 增 status 点 | 扩展现状 |
| 后台通知 | 完成经 `im-gateway` / 通知推送回主代理 | P3 |
| 注册表审计 | sqlite 查询历史子代理 / diff / 退出码 | P3 |
| 孤儿恢复 / 卡死检测 | 注册表启动扫描 + 定时扫描 | MiMo 借鉴，P3 |
| 配额护栏 | profile.limits（超时 / 并发 / token 预算） | P0+ |

---

## 8. 三家融合映射（一图看清取自谁）

| 能力 | Pi 现状 | MiMo-Code | Cursor | 本设计采纳 |
|------|---------|-----------|--------|-----------|
| 形态 | 子进程 | 同进程 actor | subprocess | **子进程**（Pi 约束）+ 分层隔离 |
| 上下文 | 无继承 | none/state/full | 强隔离无继承 | **默认无继承只回结论**（高效），自定义档案可注入 |
| 并行 | tasks≤4 | spawn+wait | 单消息多发 | tasks + 后台 spawn + 可配并发 |
| 可控 | 无 | 注册表+wait/cancel+门控 | interrupt | **sqlite 注册表 + status/wait/cancel**（P3） |
| 安全 | env 隔离 + safety | permission ruleset + toolAllowlist | readonly Ask mode | **能力档案 + safety 工具门 + 分层隔离 + 审批** |
| 可拼配 | model 单一 | per-agent permission | 9 种专精类型 | **CapabilityProfile 预设 + 内联增减**（主线） |
| 健壮 | 超时 kill | 孤儿恢复 + 卡死检测 | 会话内 | 注册表 + 孤儿恢复 + 卡死检测（P3） |

哲学定位：**Pi 求简、MiMo 求强控、Cursor 求隔离编排；本设计 = 以「能力档案」为骨、分层按需为肉，三者全都要但默认不付重成本。**

---

## 9. 分阶段路线图

每阶段独立可用、向后兼容、可单独合并与验证。

| 阶段 | 内容 | 支柱 | 依赖 | 单独价值 |
|------|------|------|------|----------|
| **P0 能力档案地基** | `capability.ts`：`CapabilityProfile` + 预设 + 解析（extends/内联）+ 把现有 `model` 收编；`spawn_agent` 增 `profile` 可选字段；profile→env 翻译层（先只接 model + 占位 fs/net/mcp） | 主线 | 无 | 统一拼配入口；为后续所有能力提供声明位 |
| **P1 只读 / 写白名单** | `safety/rules.ts` 增 `matchWriteAllowed`/`isMutatingBash`；`safety/index.ts` 接 `SAFETY_READONLY`/`SAFETY_WRITE_ALLOW`；profile.fs 驱动注入 | 安全 | P0 | 「只读 / 仅写 plans」拼配可用（improve ③） |
| **P2 worktree 隔离 + diff** | `multi-agent/worktree.ts`；profile.isolation=worktree；执行后回收 diff、清理 worktree；非 git 默认拒绝 | 安全 + 高效 | P0（与 P1 正交） | `executor` 档案：写隔离 + diff 审查（improve ②） |
| **P3 注册表 + 后台可控** | `_shared/sqlite` 子代理表；`action: spawn/status/wait/cancel`；后台回收 + 通知；孤儿恢复 + 卡死检测；UI 状态/档案徽标 | 可控 | P0 | 从「一次性」到「有状态可控」 |
| **P4 沙箱 + 配额 + 编排** | `sandbox.ts` 落地 OS 沙箱档；token/并发配额护栏；（可选）actor 间协作/链式 | 安全 + 协作 | P2/P3 | 高危隔离 + 资源护栏 + 多代理编排 |

里程碑解读：P0 一上线就让「能力可拼配」成立；P1+P2 补「安全」；P3 补「可控」；高效（并行 + 默认轻量隔离 + 只回结论）从 P0 起即默认获得。

---

## 10. 决策记录

| 决策 | 选项 | 结论 | 理由 |
|------|------|------|------|
| 落地层 | 改 cli/Rust / 仅 extensions | **仅 extensions** | 沿用 improve-adapters 原则，零后端改动、编译进 sidecar |
| 子代理形态 | 同进程 actor / 子进程 | **子进程** | Pi 现状即此；同进程需改 pi 核心，超范围 |
| 能力表达 | 散落 env+参数 / 统一档案 | **CapabilityProfile** | 直接命中「模块化可拼配、可增减」诉求；统一现有开关 |
| 默认隔离 | 全 worktree / 分层按需 | **分层按需**（默认 process，写才 worktree） | 唯一能兼顾快与安全 |
| 隔离选择 | 手动指定 / 自动按 fs 选档 | **自动选最轻 + 可显式覆盖** | 降低使用心智，安全默认 |
| 可控实现 | 内存 / sqlite 注册表 | **sqlite 注册表** | 支持 status/wait/cancel/后台/孤儿恢复；复用 `_shared/sqlite` |
| 权限传递 | 进程参数 / env 继承 | **env 继承 + 收紧** | 与 runner 现有 env 模型一致，子进程 safety 自动生效 |
| 兼容性 | 破坏式升级 / 全可选 | **全可选向后兼容** | 旧 `spawn_agent({task})` 与前端零改动 |
| 防递归 | 允许嵌套 spawn / 默认禁 | **默认 `spawn:false`** | 防子代理递归 fork 爆炸，按需显式开 |

---

## 11. 涉及文件清单

| 区域 | 文件 | 阶段 |
|------|------|------|
| 能力档案 | `extensions/multi-agent/capability.ts`（新）、`capability.test.ts`（新） | P0 |
| 工具入口 | `extensions/multi-agent/index.ts`（增 `profile` / `action`） | P0/P3 |
| 执行器 | `extensions/multi-agent/runner.ts`（profile→env/cwd 翻译、worktree、注册表写回） | P0–P3 |
| 隔离 | `extensions/multi-agent/worktree.ts`（新） | P2 |
| 安全 | `extensions/safety/rules.ts`（增纯函数）、`extensions/safety/index.ts`（接 readonly/写白名单/工具门） | P1 |
| 沙箱 | `extensions/safety/sandbox.ts`（落地） | P4 |
| 注册表 | `extensions/multi-agent/registry.ts`（新，基于 `_shared/sqlite.ts`） | P3 |
| 配置 | `extensions/_shared/runtime-config.ts`（复用 `getConfig`/`watchConfig`） | P0+ |
| 设置 UI | `tauri-agent/src/features/settings/settingsSchema.ts`（档案 / 配额字段） | P0/P3 |
| 前端展示 | `tauri-agent/src/features/panels/SubAgentConversation.tsx`、`subagentUtils.ts`、`features/dock/*`（profile 徽标 / status / cancel 按钮） | P3 |

---

## 12. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 能力档案过度设计、字段膨胀 | P0 只落 model + fs/net/mcp/spawn 必要位；其余按需加，保持「可选即默认轻」 |
| 子进程无法做到同进程级低开销 | 接受 Pi 子进程约束；用「默认 process + 只回结论」把开销压到最低，不追 inproc |
| readonly 工具门被自定义工具绕过 | 明确定位为「防呆 + 约束便宜模型」，非安全边界；真隔离留 P4 sandbox |
| 后台子代理孤儿 / 卡死 | 注册表启动扫描 + 定时卡死检测（MiMo 模式） |
| 递归 spawn 爆炸 | 默认 `spawn:false`；开启时计入全局并发配额 |
| 与 improve-adapters 计划重叠 | 本设计是其超集：P1=improve③、P2=improve②；落地时合并，避免重复实现 |
| Windows 路径 / git worktree 兼容 | 复用 `checkpoint/snapshot.ts` 的 Windows 安全 git argv 风格 |

---

## 13. 规格自检

- [x] 三支柱（可控 / 高效 / 安全）均有明确落点与阶段
- [x] 「能力模块化可拼配、可增减」= CapabilityProfile（§3）一等公民
- [x] 落地约束（仅 extensions、子进程、向后兼容）贯穿
- [x] 与现状基线、improve-adapters 对齐，无重复实现
- [x] 路线图每阶段独立可用、可验证
- [ ] 待用户确认阶段切分与 P0 起步范围后，转 `writing-plans` 产出实现计划
