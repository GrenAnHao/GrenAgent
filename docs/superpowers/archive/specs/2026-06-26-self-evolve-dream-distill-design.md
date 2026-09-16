# 自进化扩展 self-evolve（dream + distill）设计

**目标：** 为 Pi 移植 MiMo Code 的自进化机制，新增扩展 `extensions/self-evolve/`，提供两条能力：

- **dream（知识固化）：** 定期回顾近期会话，把持久知识固化进 long-term-memory 记忆库，并生成人类可读的 `MEMORY.md`，清理过期项。
- **distill（行为提炼）：** 定期回顾近期会话，识别重复的手工工作流，打包成最小形态的可复用资产（skill / 子 agent / command）。

两者均以「专用 subagent + 间隔自动触发 + 手动命令」运行，贴合 MiMo 的工程化分治（主 agent 只管干活，进化交给独立 agent）。

**来源：** MiMo Code `packages/opencode/src/session/auto-dream.ts`、`agent/prompt/dream.txt`、`agent/prompt/distill.txt`、`session/prompt.ts`（触发点）、`agent/agent.ts`（dream/distill subagent 定义）。

**技术栈：** TypeScript Pi 扩展（`ExtensionAPI`），typebox schema，运行于 sidecar（bun --compile 打包）。复用 `multi-agent` runner、`long-term-memory`、`session-search`、`SessionManager`。

---

## 背景：MiMo 机制 × Pi 现状对照

| MiMo 机制 | Pi 对应 | 结论 |
|---|---|---|
| 轨迹 SQLite DB 作真相源 | `SessionManager.list(cwd)` 返回各会话 `allMessagesText`/`id`/`modified`/`firstMessage`；`history_search` 工具 | 用 SessionManager 代替 SQLite，无需新建索引 |
| dream → `MEMORY.md` 文件 | `long-term-memory` 向量 DB（`memory_save`/`recall` + `consolidate`/`extractFacts`），按 prompt 自动注入 | dream 复用记忆库**并**新增人读 `MEMORY.md` 层 |
| distill → skill/agent/command | `fable-behavior` 已能向 `~/.pi/agent/agents/` 播种 agent 模板；cli 以 `skill:<name>` 暴露技能 | distill 全新，资产写 `~/.pi/agent/{agents,skills,commands}/` |
| dream/distill 为 subagent | `multi-agent` runner spawn `pi --mode json -p`（用 `process.execPath` 即 sidecar 自身） | 复用该 spawn 模式 |
| 会话 step1 间隔触发（查 SessionTable 上次运行时间） | `pi.on("session_start")`（顶层会话）；无 SessionTable，用标记文件记上次运行 | 标记文件 + 项目年龄门槛 |
| 注入 MEMORY.md 到上下文 | `before_agent_start` 钩子返回 `{ message: { customType, content, display } }` | 同 long-term-memory 注入路径 |

## 非目标（YAGNI）

- 不做常驻调度守护进程；仅 `session_start` 间隔触发 + 手动命令。
- 不移植 MiMo 的远程 skill 市场拉取（`discovery.ts`）。
- distill 不修改源码、不做任何不可逆外部动作（不建账号/不发消息/不改权限），只产出描述性资产。
- dream/distill 把真相源（会话）视为只读。
- 不替换 long-term-memory；dream 是其上的「定期批处理 + 人读索引」层。

---

## 架构总览

```
session_start (顶层会话)
  └─ scheduler: 读标记文件判间隔(dream 7d/distill 30d) + 项目年龄门槛 + 10s 防抖
        └─ 到期 → fire-and-forget spawn 子代理(后台, 不阻塞会话)
  └─ before_agent_start: 注入 项目+全局 MEMORY.md (≤4KB)

/dream /distill 命令 → 同 spawn 路径(force, 跳间隔)

子代理(pi --mode json -p, persona + 限定工具):
  读 SessionManager.list / history_search / memory_recall
  dream  → memory_save(记忆库) + 写/合并/prune MEMORY.md
  distill → 盘点已有资产 → 写最小形态 skill/agent/command
  → 写标记文件(本次运行时间) → 返回摘要
```

数据流闭环：子代理产出 → 下次 `session_start` 注入 MEMORY.md / distill 资产经 Pi 既有 agent/skill/command 加载机制生效。

---

## 组件详述

### 1. `schedule.ts` — 纯间隔判定 + 标记 IO

纯函数（可单测，时钟与 IO 注入）：

```ts
interface ScheduleInput {
  enabled: boolean;
  intervalMs: number;
  lastRunMs: number | undefined;     // 来自标记文件
  earliestSessionMs: number | undefined; // 项目年龄门槛
  now: number;
  lastSpawnMs: number;               // 进程内防抖(10s)
}
function shouldRun(i: ScheduleInput): boolean;
```

规则（对齐 MiMo `shouldAutoRun`）：

- `enabled=false` → false。
- `now - lastSpawnMs < 10_000` → false（防抖，避免一次启动多会话重复 spawn）。
- 首次（无 lastRun）：若 `earliestSession` 不存在或 `now - earliest < intervalMs` → false（项目太年轻，无可固化）。
- `lastRun` 存在且 `now - lastRun < intervalMs` → false。
- 否则 → true。

标记文件：

- dream：`<cwd>/.pi/memory/.self-evolve-dream`（项目级）。
- distill：`<cwd>/.pi/memory/.self-evolve-distill`（项目级）。
- 内容：上次运行的 epoch ms（纯文本）。读失败视为 undefined（首次）。

`earliestSessionMs` 由 `SessionManager.list(cwd)` 取最早会话 `modified` 推得。

### 2. `runner.ts` — spawn 子代理

镜像 `multi-agent/runner.ts` 的最小 spawn：`process.execPath`（PI_BIN 可覆盖）+ `--mode json -p`，把 persona 任务作为 prompt 传入，限定工具集，超时（默认 300s，dream/distill 比普通子代理重），fire-and-forget（错误仅 log，绝不阻塞 session_start）。

- 工具限定：`read/write/edit/glob/grep/bash` + `memory_save/memory_recall/memory_update` + `history_search`。经 `SAFETY_DENY_TOOLS`（复用 safety 扩展的 env 闸）排除其余（尤其网络/危险执行）。
- 模型：`SELF_EVOLVE_MODEL` → 否则 `SUBAGENT_MODEL` → 否则继承默认。
- 真相源只读：persona 明确「会话与记忆库为只读」。

### 3. personas — dream.md / distill.md 系统提示词

由 MiMo `dream.txt`/`distill.txt` 改编为 Pi 版，播种到 `getAgentDir()/agents/{dream,distill}.md`（仿 `fable-behavior/seed.ts`：if-absent + 版本标记 `.self-evolve-seed-version`，用户可覆盖）。

**dream 阶段：** 定位数据（MEMORY.md + 记忆库 + 会话列表）→ 取近 7 天会话（`history_search`/SessionManager）→ 从会话提取候选持久事实 → 交叉验证（重复出现/明确用户陈述/设计决策）→ 固化：`memory_save` 进记忆库 + 合并进 `MEMORY.md`（分节：Rules / Architecture decisions / Discovered knowledge / Patterns / Gotchas，每条 1-3 行，带来源会话 id）→ prune（去重/去过期/MEMORY.md ≤200 行 ≤10KB）→ 摘要。工作流打包属 distill，dream 只一行提示。

**distill 阶段：** 定位数据 → **先盘点**已有 `~/.pi/agent/{agents,skills,commands}/` 与项目 `.pi/` 资产 → 从会话发现重复工作流（≥2 次或明显高频高成本）→ 短名单（证据/频次/置信/推荐形态）→ 选最小形态 → 仅创建高置信缺失项（skill=`SKILL.md` 带 `name`/`description` frontmatter；agent=`<name>.md` 带 frontmatter+系统提示；command=`<name>.md` 带 `$ARGUMENTS` 模板）→ 校验引用路径/符号 → 摘要。无重复则不造（合法结果）。

### 4. `memory-file.ts` — MEMORY.md 读 / 注入 / prune 辅助

供注入与（可选）程序化 prune：

- `readMemoryFiles(cwd)`：读项目 `<cwd>/.pi/memory/MEMORY.md` + 全局 `getAgentDir()/MEMORY.md`，缺失返回空。
- `formatInjection(project, global, maxChars)`：拼接为注入正文，超 `maxChars`（默认 4096）截断（项目优先）。
- 纯函数，可单测（格式/截断/缺失）。

### 5. `index.ts` — 扩展装配

```ts
export default function (pi: ExtensionAPI) {
  seedPersonas();                              // 播种 dream.md/distill.md (if-absent)
  pi.on("session_start", scheduler);           // 顶层会话判间隔 → 后台 spawn
  pi.on("before_agent_start", injectMemory);   // 注入 MEMORY.md
  pi.registerCommand("dream",  { handler: () => runDream({ force: true }) });
  pi.registerCommand("distill",{ handler: () => runDistill({ force: true }) });
}
```

- `scheduler`：仅顶层会话（非子代理；避免 dream/distill 自身再触发 → 用 env 哨兵如 `SELF_EVOLVE_CHILD=1` 标记子进程并跳过）。dream 与 distill 各自独立判定。
- `injectMemory`：`before_agent_start` 返回 `{ message: { customType: "self-evolve-memory", content, display: false } }`（display:false 避免污染可见对话）。

---

## 配置（`SELF_EVOLVE_*`，走 `_shared/runtime-config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `SELF_EVOLVE_AUTO` | `1` | 自动触发总开关（`0` 关闭，仅留手动命令） |
| `SELF_EVOLVE_DREAM_INTERVAL_DAYS` | `7` | dream 间隔；`0` = 每次顶层会话 |
| `SELF_EVOLVE_DISTILL_INTERVAL_DAYS` | `30` | distill 间隔 |
| `SELF_EVOLVE_MODEL` | 空 | 子代理模型；空则回退 `SUBAGENT_MODEL` |
| `SELF_EVOLVE_MEMORY_INJECT` | `1` | 是否注入 MEMORY.md |
| `SELF_EVOLVE_MEMORY_MAX_CHARS` | `4096` | 注入上限 |
| `SELF_EVOLVE_TIMEOUT_MS` | `300000` | 子代理超时 |

## 错误处理与安全

- session_start 的调度与注入全程 try/catch，绝不阻塞或抛出影响主会话冷启动。
- 子代理 fire-and-forget；失败仅 log（参考 MiMo `.catch(log.error)`）。
- 子进程设 `SELF_EVOLVE_CHILD=1`，调度器据此跳过（防递归自触发）。
- 会话与记忆库对子代理只读；distill 只产出描述性资产，禁不可逆外部动作（persona 明确 + safety 闸）。
- 标记/MEMORY.md 文件 IO 全 best-effort。

## 测试策略

- `schedule.test.ts`：`shouldRun` 全分支（关闭/防抖/首次年龄门槛/未到期/到期）；标记文件读写（注入临时目录）。
- `memory-file.test.ts`：读缺失/格式拼接/截断（项目优先）/全局合并。
- spawn 用 mock（注入 runner 依赖），不起真子进程；命令 handler 调用 runner 一次、传 force。
- 遵循既有 vitest 约定（`extensions/**/*.test.ts`，`bunx vitest run`）。

## 文件清单

- 新增：`extensions/self-evolve/index.ts`
- 新增：`extensions/self-evolve/schedule.ts`（+ `schedule.test.ts`）
- 新增：`extensions/self-evolve/runner.ts`
- 新增：`extensions/self-evolve/memory-file.ts`（+ `memory-file.test.ts`）
- 新增：`extensions/self-evolve/seed.ts`（persona 播种 + 默认模板）
- 新增：`extensions/self-evolve/personas/dream.md`、`personas/distill.md`（默认模板，编译进 seed）
- 新增：`extensions/self-evolve/package.json`
- 修改：`extensions/index.ts`（import + `allExtensions` + `namedExtensions` 注册，置于 long-term-memory 附近）

## 默认值汇总（可调）

dream 7d / distill 30d；auto 默认开；MEMORY.md 项目+全局双写；注入上限 4KB；子代理超时 300s；资产写 `~/.pi/agent/{agents,skills,commands}/`，MEMORY.md 项目写 `<cwd>/.pi/memory/MEMORY.md`、全局写 `~/.pi/agent/MEMORY.md`。
