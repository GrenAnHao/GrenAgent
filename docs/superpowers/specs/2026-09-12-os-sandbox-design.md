# OS 沙箱规格 1：进程 confine 与五档审批

- 日期：2026-09-12
- 状态：设计已评审 → 2 项裁决已确认 → 可进 writing-plans
- 主题：为 Agent 的 `bash` / `pwsh` 落地本机 OS 进程沙箱。能力面对齐 DeepSeek Harness 的 `confine(argv)`、失败关闭、一次性升权；策略轴对齐 Codex 的「文件 + 网络」拆分。三平台同期交付：Windows 受限令牌 + ACL、Linux bwrap / Landlock、macOS Seatbelt。本文件取代 `2026-06-19-unified-sandbox-design.md` 中「WSL2 + sandbox-runtime、不可用则降级宿主」的路线。

> **裁决记录（2026-09-12）**
>
> - **A · 平台范围 = 三平台同期**：Windows / Linux / macOS 各有 runner，**均在本规格实现范围内**，不再是非目标。
> - **B · Ask 放开 `bash`**：`ASK_TOOLS` 增列 `bash`，Ask 下可跑只读命令；写由 `read-only` runner 强制拒绝——OS 是**主防线**，不是纵深防御。

## 1. 背景与目标

Pi 现在没有 OS 隔离。`electron-agent/electron/app/sandbox/sandboxManager.ts` 只做路径和环境过滤；`osIsolation` 默认为 false，`degraded` 为 true 时命令仍在宿主上真跑。审批三档（请求批准 / 替我审批 / 完全访问）只调确认强度，危险命令靠 `extensions/safety` 的正则。实测里 `auto` 下放行的命令会在本机执行。

6 月统一沙箱设计走 WSL2 + `@anthropic-ai/sandbox-runtime`，未接到当前 bash 路径；`sandbox_sh` 已从工具集删除。桌面主线是 Electron；`tauri-agent` 冻结，不在本规格实现范围。

`bash` 来自官方 `@earendil-works/pi-coding-agent`，在 **pi-worker 子进程**内执行（`cli/src/pi-worker.ts` 调 `main(argv, { extensionFactories: allExtensions })`），不是 Electron 主进程。沙箱必须插在最后一次 spawn 之前，插口在 extension 侧。

### 成功标准

1. 受限档位（非「完全权限」）的 `bash` / `pwsh` 必须经 `confine(argv)` 再执行；没有 runner 则不执行，并引导启用 runner 或改选完全权限。禁止静默降级宿主。
2. 用户仍只操作现有审批选择器。三档扩为五档（UI、`approvalStore`、`piRuntimeService` 校验与 `agent_set_approval` IPC 四处同步）。Ask 模式锁定 `read-only`。
3. 文件效果由 OS runner 强制执行，三平台各有实现：Windows 受限令牌 + ACL（`partial`，只拦写）、Linux bwrap / Landlock（`full`）、macOS Seatbelt（`full`）。`enforcement` 由 provider 上报，不硬编码。
4. OS 拒写后，仅查看 / 请求批准 / 替我审批允许模型经 `bash_escalate` 对**同一条命令**申请一次性加宽，人批；工作区编辑拒绝升权。升权不改会话默认档。
5. 规格写齐三平台词汇与 `confine` 接口。只有**本平台探测不到自己的 runner** 才抛 `SANDBOX_UNAVAILABLE`——不假装已隔离，也不跨平台顶替。
6. 「问人」通道在 pi-worker 下实测可达；不可达时按 §6 兜底为「这次调用失败」，不得自动放行。
7. 三平台都必须提供可用 runner；失败关闭只在探测失败 / 系统不支持时触发，不提供宿主降级。
8. Ask 模式放开 `bash`（`ASK_TOOLS` 增列），且 Ask 下所有 `bash` 必须经 `read-only` 的 `confine`：OS 拒写是这里的**主防线**。

### 后续规格（不在本文件实现）

能力面按 Harness 拉满，但拆开写：

- 规格 2：`write` / `edit` 走同一套文件效果。
- 规格 3：PTY 终端（长驻交互壳）。
- 规格 4：code-exec / 子代理继承父会话策略。
- 规格 5：网络轴真强制执行（Linux `unshare-net` / 代理，或 Windows elevated + WFP）。本规格只留词汇。

## 2. 产品：五档审批

一个选择器，内部拆成文件沙箱 × 确认强度。Ask 是左边的模式，不是第六档。

| 档 | 文件模式 | 确认 | 升权 |
| --- | --- | --- | --- |
| 仅查看 | `read-only` | 联网工具与升权问人 | 问人 |
| 请求批准 | `workspace-write` | 越界意图 / 联网 / 危险命令 / 升权问人。越界写由 OS 拒，再走升权 | 问人 |
| 替我审批 | `workspace-write` | 只问危险命令（现有 auto） | 仍问人，不自动加宽 |
| 工作区编辑 | `workspace-write` | 不问 | 直接拒绝 |
| 完全权限 | `danger-full-access` | 不问 | 不经过沙箱拒写 |

Ask 模式：`resolvePreset` 忽略选择器，强制 `read-only`。**Ask 放开 `bash`（裁决 B）**：`ASK_TOOLS` 增列 `bash`，Ask 下可跑命令，写由 OS `read-only` runner 强制拒绝——OS 是主防线，白名单只决定工具可见性。想改档先退出 Ask。

> **与 plan 模式的关系（放开后必须厘清）**：plan 已有 `PLAN_TOOLS = [...ASK_TOOLS, "bash"]` + `isSafeCommand` 正则白名单。两者**分层而非替代**——`isSafeCommand` 是意图层（先滤掉明显非只读的命令），OS runner 是强制层。plan 不强制 `read-only`，按所选审批档解析 mode；Ask 强制 `read-only`。
> 放开后需回归两者判定不一致的观感：`isSafeCommand` 放行但 OS 拒写 → 走 §5 升权；Ask 下 `read-only` 只能加宽到 `workspace-write` / `danger-full-access`，仍需人批。

> 表中「联网问人」是**确认态**，不是强制态：本规格 `network` 恒为 `enabled`，OS 不断网（见 §4.1）。

「完全权限」= 关沙箱且不问。现有文案「完全访问」并入这一档，不再表示「不问但可能仍有沙箱」。

## 3. 架构

自研 Harness 形 seam，不引入 Cordis，不依赖 `dsh-sandbox` 包，不走 WSL2。

```text
五档 / Ask 锁定
    → resolvePreset → SandboxExecutionPolicy
    → safety（危险命令、受保护路径）
    → danger-full-access：官方工具原样 spawn
    → 其余：confine(argv) → spawn 包后的 argv
    → 退出归因：runner 失败 / 文件拒写 / 命令失败
    → 拒写：pending denial → bash_escalate（校验）→ 按档问人做一次性加宽
```
（`bash` 与 `user_bash` 两个入口都经此链路。）

`SandboxManager` 不再在 `degraded` 后裸跑。它只调用 `resolvePreset`；不可用时把错误交给 UI 引导。

safety 继续做危险命令和受保护路径，不再假装自己是 OS 沙箱。升权的校验与档位裁决由沙箱扩展的 `bash_escalate` 承担，safety 不发明策略、不代批。

## 4. 组件

### 4.1 类型（无 I/O）

```ts
type FileSandboxMode = "read-only" | "workspace-write" | "danger-full-access"
type NetworkSandboxPolicy = "restricted" | "enabled"
type SandboxEnforcement = "full" | "partial"

interface SandboxExecutionPolicy {
  mode: FileSandboxMode
  network: NetworkSandboxPolicy
  workspaceRoot: string
  sessionId?: string
}

interface SandboxPolicy extends SandboxExecutionPolicy {
  mode: Exclude<FileSandboxMode, "danger-full-access">
}

/** runner 自身故障的归因规则。与「文件拒写」互斥：先判此类，再判拒写。 */
interface RunnerFailureRule {
  kind: "runner-missing" | "runner-launch-failed" | "runner-internal"
  exitCodes: readonly number[]
  signatures: readonly string[]
}

interface ConfinedArgv {
  argv: string[]
  enforcement: SandboxEnforcement
  /** 结构化拒写判据：runner 专用退出码，优先级高于文本签名 */
  denialExitCodes: readonly number[]
  /** 次级判据：stdout / stderr 文本签名。locale 敏感、可能被命令回显误命中，仅作兜底 */
  denialSignatures: readonly string[]
  runnerFailureRules: readonly RunnerFailureRule[]
}

interface SandboxProvider {
  /**
   * 有可用 runner 则返回包装后的 argv；否则抛 SANDBOX_UNAVAILABLE。
   * 禁止把未包装的 argv 当作成功结果返回。异步：runner 探测可能涉 I/O。
   */
  confine(argv: string[], policy: SandboxPolicy): Promise<ConfinedArgv>
  /** 释放 sessionId 对应的一次性资源（每会话私有临时目录等） */
  dispose?(sessionId: string): Promise<void>
}

/** 模型侧一次性升权请求（§5）。 */
interface BashEscalationRequest {
  /** 必须与最近一次被拒的命令逐字节相同 */
  command: string
  /** 人类可读理由，最短 20 字符 */
  justification: string
  /** 只允许相对当前 mode 加宽 */
  targetMode: FileSandboxMode
}
```

本规格中 `resolvePreset` 写出的 `network` 恒为 `enabled`。`restricted` 留给后续网络规格；Windows ACL 不能声称已断网。

`SandboxEnforcement` 只描述**文件轴**的强制完整度，与网络轴无关——网络轴本期恒为 `enabled`，不参与取值。

### 4.2 `resolvePreset`

输入：会话审批档、是否 Ask、工作区根、会话 id。输出：完整 `SandboxExecutionPolicy`。不 spawn。

### 4.3 `SandboxProvider.confine`

`confine(argv, policy: SandboxPolicy): Promise<ConfinedArgv>`

只接受非 `danger-full-access` 的策略。有可用 runner 则返回包装后的 argv；否则抛 `SANDBOX_UNAVAILABLE`。禁止把未包装的 argv 当作成功结果返回。

**调用方只有我们自己实现的 `BashOperations.exec`（§4.5）**，不是官方 `bash` 工具——官方 seam 交付的是 command 字符串，argv 在进入 `confine` 之前由我们组装。传入的是精确 argv 数组，不是整段 shell 字符串：`[shellPath, "-c", command]`（Windows 上解析到的 `bash.exe` 或 `pwsh.exe`）。因为同一条 `command` 确定性地映射到同一条 argv，「重试同一条命令」等价于「重试同一条 argv」。

`confine` 是异步的（runner 探测可能涉 I/O），这也是不能走同步 `spawnHook` 的原因之一。

### 4.4 三平台 runner

按 `process.platform` 选 provider，`enforcement` 由 provider 上报，不硬编码。三家都只拦文件写，网络轴留给规格 5。

#### 4.4.1 Windows：受限令牌 + ACL

移植 Harness 的写限制思路，自维护实现：

- `CreateRestrictedToken`（`WRITE_RESTRICTED` + 降特权）
- 工作区能力 SID + 每会话私有临时目录 SID
- 只拦写；读和套接字不拦
- `enforcement` 固定为 `partial`（Everyone 可写对象、NTFS 硬链接等缺口与 Harness 相同）
- partial 时照常执行，结果和 UI 标明只拦写；不把 partial 当成 `UNAVAILABLE`

#### 4.4.2 Linux：bubblewrap + Landlock

- 主路径 `bwrap`：`--ro-bind` 全盘只读 + `--bind` 工作区与每会话临时目录可写 + `--die-with-parent` + `--unshare-pid`，配套 `PR_SET_NO_NEW_PRIVS`。
- 内核 ≥ 5.13 时叠加 Landlock（探测 ABI 版本，逐级降到可用的最低 ABI）；缺 Landlock 时 `bwrap` 单独仍成立。
- **本期不加 `--unshare-net`**：网络强制属规格 5，避免与「`network` 恒为 `enabled`」的口径冲突。
- `enforcement` 为 `full`。
- 探测链：`bwrap` 存在 → Landlock 内核版本 → 无 `bwrap` 则 `SANDBOX_UNAVAILABLE`，不退化到宿主。

#### 4.4.3 macOS：Seatbelt

- `sandbox-exec` + 自维护 profile：`(deny default)` + 放行读 + 工作区与每会话临时目录写 + 必要系统调用，口径对齐 Codex。
- `enforcement` 为 `full`。
- 探测：`/usr/bin/sandbox-exec` 可用且 profile 能编译（一次性自检）；失败则 `SANDBOX_UNAVAILABLE`。

#### 4.4.4 共用契约

**拒写判据**：优先结构化通道——runner 以 `denialExitCodes` 内的专用退出码退出即判拒写；`denialSignatures` 仅作次级兜底（命令回显同类文字会误命中，非英文 locale 会漏判，两者都不许反过来否决结构化判据）。

**每会话私有临时目录**：首次 `confine` 时按 `sessionId` 创建，由 `SandboxProvider.dispose(sessionId)` 在会话结束时清理；进程崩溃遗留的目录在下次启动按 TTL 回收。Linux / macOS 下该目录同时是 bind-mount / profile 的放行项。

**进程契约不在 `ConfinedArgv` 内**：runner 只负责给出 argv 与归因规则，进程创建、stdio 转发、abort / 超时终止由 §4.5 的 `operations` 承担。

### 4.5 bash / pwsh 消费方

**注入点唯一**：`createBashTool(cwd, { operations })` + `pi.registerTool`，并用 `pi.on("user_bash", () => ({ operations }))` 覆盖 `!` / `!!` 前缀通道。两者都是官方公开 API（`BashOperations` / `UserBashEventResult`），不是补丁。

`operations.exec(command, cwd, { onData, signal, timeout, env })` 由我们实现：

1. 解析 shell 绝对路径并组 argv。POSIX：`[shellPath, "-c", command]`。Windows 默认壳与 argv 以 `docs/superpowers/specs/2026-09-15-windows-powershell-shell-design.md` 为准：`pwsh.exe` 或 Windows PowerShell 5.1，`[shell, "-NoProfile", "-NonInteractive", "-Command", UTF-8 前缀 + command]`，不是 Git Bash `-c`。`operations.exec` 自己解析壳并 spawn，**不经** `cli/scripts/patch-pi-shell.mjs`（该补丁只打 SDK `dist/utils/shell.js` / 官方 `createLocalBashOperations`）。若将来启用官方 `powershell` 工具，必须接入同一 `operations`，否则构成绕过。
2. `await confine(baseArgv, policy)`。抛 `SANDBOX_UNAVAILABLE` 则命令不执行，按 §6 引导。
3. `spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] })`——**不经 shell**。
4. stdout / stderr 转发 `onData`；`signal` 与 `timeout` 终止整棵进程树。
5. 归因：先 `runnerFailureRules`，再 `denialExitCodes` / `denialSignatures`。

**代价与约束（明确接受，不是遗漏）**：

- 包 argv 后**必须自持 spawn**，无法复用 `createLocalBashOperations()`（它只吃 command 字符串）。这不是「Codex 式全部经主进程 transform」——只接管 `bash` 与 `user_bash` 两个入口，其余工具路径不变。
- `spawnHook` **禁用**：它同步返回 command 字符串，既撑不起异步 runner 探测，也会把模型可控的命令串再嵌一层 shell，形成命令注入面。
- **不引入任何对 `pi-coding-agent` `dist/` 的补丁作为沙箱注入点**。`patch-pi-shell` 只打 SDK `dist/utils/shell.js` / 官方 `createLocalBashOperations`，与本仓库 `operations.exec` 无关，升级时仍列为必查项。本仓库 `bash` 工具的 Windows 壳定位已改走 `_shared/sandbox/shellPath.ts`，升级 SDK 时仍检查 patch，但不要假设它影响 `operations.exec`。
- 进程树终止分平台：Windows 不能用 `process.kill(-pid)`，改用 Job Object 或 `taskkill /pid <pid> /t /f`；POSIX 用 `detached: true` + `process.kill(-pid)`。

**工具名覆盖**：官方默认 built-ins 为 `read` / `bash` / `edit` / `write`，`powershell` 未启用。本规格按「Pi 不启用 `powershell` 工具名」编写；若将来启用，必须接入同一 `operations`，否则构成绕过。argv[0] 为 `pwsh` 时走同一 `confine`。完全权限不调用 `confine`。

### 4.6 放置

- `extensions/_shared/sandbox`：类型、`resolvePreset`、`confine` 接口、错误类型
- 同目录或并列的 local provider：按 `process.platform` 选 runner 并探测（Windows / Linux / macOS 三家）；`bash_escalate` 工具与 pending-denial 记录
- `extensions/agent-mode/modes.ts`：`ASK_TOOLS` 增列 `bash`（裁决 B）；`gateToolCall` 与 `toolWhitelist` 不变，只读保证改由 OS runner 承担
- 审批档五档化**必须四处同步**，缺一处新档位就会被旧校验挡下：
  - `src/stores/approvalStore.ts` + `ApprovalAction.tsx`（UI / 图标 / 文案）
  - `electron/app/piRuntimeService.ts` `writeApprovalPolicy` 的白名单校验（现为 `ask | auto | full`，否则抛 `INVALID_APPROVAL_POLICY`）
  - `agent_set_approval` IPC 与 `lib/pi.ts`
- `SandboxManager`：改为 resolve + 不可用引导，删除 degraded 裸跑路径。**只约束 `bash` / `user_bash`**；PTY 终端（`shellService.ts`）与子代理取消（`subagentService.ts`）仍用 `prepare()` 做纯路径校验，不引入 runner 失败关闭——两者属于后续规格，不得被本次改动连带打断。

## 5. 数据流与升权

1. 解析策略（Ask 则强制仅查看）。
2. safety 危险闸。替我审批只在此问危险命令。
3. 完全权限：原样 spawn。
4. 其余：`confine` 后 spawn。无 runner：不执行，引导。
5. 文件拒写：记录一条 **pending denial**（键 = 工作区 + 被拒命令，单次消费、用后即焚），并在工具结果里回「当前 `mode` + 可申请加宽 + 需给 justification」。不描述任何绕过手法。
6. 模型若要升权，调用 `bash_escalate({ command, justification, targetMode })`（`BashEscalationRequest`）。这是**唯一的模型侧升权通道**；`bash` 工具的入参只有 `{command, timeout}`，本身无法表达升权。校验顺序：
   - 存在未消费的 pending denial，且 `command` 与它**逐字节相同**；
   - `justification` 非空且 ≥ 20 字符；
   - `targetMode` 相对当前 `mode` **严格加宽**：
     - `read-only` → `workspace-write` 或 `danger-full-access`
     - `workspace-write` → `danger-full-access`
   改命令、变窄、无 justification、无 pending denial —— 一律拒绝，不进入问人。
7. 档位裁决：
   - 仅查看 / 请求批准 / 替我审批 → `ctx.ui.select` 问人（展示原命令、justification、目标档位）。允许则这次调用用更宽策略再 `confine`（或 full-access 裸跑），并消费 pending denial。
   - 工作区编辑 → 直接拒绝，不弹窗。
   - 升权被拒 / 取消 / UI 通道不可用 → 这次调用失败，pending denial 作废，会话档不变。
8. 升权一律不改会话默认档，只对这一次调用生效。

禁止在工具结果里教模型换一种方式绕过沙箱。

## 6. 错误处理

| 情况 | 行为 |
| --- | --- |
| 无 runner | `SANDBOX_UNAVAILABLE`，命令未跑，UI 引导启用 runner 或改选完全权限 |
| runner 已包 argv 但 helper 未执行命令 | 基础设施错误（按 `runnerFailureRules` 判定），不当成拒写 |
| 文件拒写 | 记 pending denial，走第 5 节升权表 |
| Windows partial | 执行，标明只拦写 |
| Ask 下改审批档 | resolve 仍强制仅查看 |
| `user_bash`（`!` / `!!`） | 与 `bash` 同一策略、同一 `operations`；不因走用户输入通道而豁免 |
| UI 通道不可用（headless / 超时） | 这次调用失败，**不得自动放行**；与 2026-06-19 设计中「ask 在 headless 降级为 auto」的做法相反 |

## 7. 测试

- `resolvePreset`：五档 × Ask 锁定；`network` 恒 `enabled`。
- `confine`：无 runner 抛 `SANDBOX_UNAVAILABLE`；`danger-full-access` 不得进入 `confine`；返回 argv 必须已被包装（断言不等于入参）。
- `bash_escalate`：只许加宽；改命令 / 变窄 / 缺 justification / 无 pending denial 全部拒绝；pending denial 单次消费；工作区编辑不弹窗。
- 归因：`runnerFailureRules` 与拒写判据不混用；`denialExitCodes` 优先于 `denialSignatures`；文本签名被命令回显误命中时不得触发升权。
- 进程契约：abort 与 timeout 能终止整棵进程树（Windows 专项）；退出码正确透传。
- `SandboxManager`：不存在 degraded 裸跑路径；PTY 与子代理取消的纯校验路径未被失败关闭波及。
- 审批档四处（store / UI / `piRuntimeService` / IPC）对五档值一致接受，旧值不被 `INVALID_APPROVAL_POLICY` 挡下。
- **真隔离套件按平台 gating**，三平台各自必跑（不可只跑 Windows）：Windows ACL（win32 runner）／Linux bwrap + Landlock（linux runner）／macOS Seatbelt（darwin runner，需 macOS CI）。断言：越界写被拦、工作区内写放行、`enforcement` 与预期一致。
- 探测失败路径：注入「runner 缺失」→ `SANDBOX_UNAVAILABLE` 且命令未执行；不得跨平台顶替。
- Ask 放开回归：`ASK_TOOLS` 含 `bash`；Ask 下写类命令被 OS 拒、只读命令通过；`isSafeCommand` 放行但 OS 拒写时走 §5 升权。

## 8. 非目标（规格 1）

- 不实现网络断网、代理、MITM（Linux 因此不加 `--unshare-net`，见 §4.4.2）。
- 不罩 `write` / `edit`、PTY、code-exec、子代理。
- 不引入 Cordis / 不直接依赖 DeepSeek npm 包。
- 不恢复 WSL2 + `srt` 作为 Windows 主路径。
- 不做 Guardian / 自动代批升权。
- 不把审批改回两轴两个选择器。
- 不打 `pi-coding-agent` `dist/` 补丁作为沙箱注入点（已确认有官方公开 seam）。
- 不用同步 `spawnHook` 做命令包装（注入面 + 撑不起异步探测）。
- 不复用 `createLocalBashOperations()`（包 argv 后必须自持 spawn）。
- 不在本次改动中把 PTY / 子代理纳入失败关闭。

## 9. 与旧文档的关系

- `docs/superpowers/archive/specs/2026-06-19-unified-sandbox-design.md`：WSL2 路线废弃，以本文件为准。
- `docs/superpowers/archive/specs/2026-06-19-approval-policy-design.md`：三档「沙箱 scope + 确认」的产品假设改为本文件的五档融合；本规格落地前，现网仍是确认强度三档。
- `docs/superpowers/specs/2026-09-02-pi-codex-desktop-agent-design.md` 中 SandboxManager 的「能力不足则降级并遵守应用层 deny/ask」：本规格改为能力不足则失败关闭并引导，不再降级裸跑。

**代码残留**：旧 WSL2 沙箱层已无残留（`extensions/_shared/sandbox-gate.ts`、`sandboxOn` / `sandboxAvailable`、`SANDBOX_ENABLE`、`sandbox_sh` 工具均已不存在），本次不需要迁移代码，只需沿用 `extensions/_shared/` 的放置约定。

**明令禁止的反模式**：官方 `examples/extensions/sandbox/index.ts` 中 `if (!sandboxEnabled || !sandboxInitialized) return localBash.execute(...)` 正是「静默降级宿主」的样板，本规格全面禁止。官方示例在 Windows 上亦只做 notify 不支持——Windows 侧能力完全由本规格自研补齐。

**评审记录**：`docs/superpowers/specs/2026-09-12-os-sandbox-design-review.md`（含与 SDK / 现有代码的逐条事实核对）。评审中提出的「POSIX runner 属非目标」已因裁决 A 撤销——本规格现在包含 Linux / macOS runner 实现。
