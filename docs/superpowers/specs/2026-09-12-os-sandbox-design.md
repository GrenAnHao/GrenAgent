# OS 沙箱规格 1：进程 confine 与五档审批

- 日期：2026-09-12
- 状态：设计已评审（待用户最终确认 → writing-plans）
- 主题：为 Agent 的 `bash` / `pwsh` 落地本机 OS 进程沙箱。能力面对齐 DeepSeek Harness 的 `confine(argv)`、失败关闭、一次性升权；策略轴对齐 Codex 的「文件 + 网络」拆分。实现先做 Windows ACL。本文件取代 `2026-06-19-unified-sandbox-design.md` 中「WSL2 + sandbox-runtime、不可用则降级宿主」的路线。

## 1. 背景与目标

Pi 现在没有 OS 隔离。`electron-agent/electron/app/sandbox/sandboxManager.ts` 只做路径和环境过滤；`osIsolation` 默认为 false，`degraded` 为 true 时命令仍在宿主上真跑。审批三档（请求批准 / 替我审批 / 完全访问）只调确认强度，危险命令靠 `extensions/safety` 的正则。实测里 `auto` 下放行的命令会在本机执行。

6 月统一沙箱设计走 WSL2 + `@anthropic-ai/sandbox-runtime`，未接到当前 bash 路径；`sandbox_sh` 已从工具集删除。桌面主线是 Electron；`tauri-agent` 冻结，不在本规格实现范围。

`bash` 来自官方 `@earendil-works/pi-coding-agent`，在 Electron 主进程内嵌 SDK 里 spawn。沙箱必须插在最后一次 spawn 之前。

### 成功标准

1. 受限档位（非「完全权限」）的 `bash` / `pwsh` 必须经 `confine(argv)` 再执行；没有 runner 则不执行，并引导启用 runner 或改选完全权限。禁止静默降级宿主。
2. 用户仍只操作现有审批选择器。三档扩为五档。Ask 模式锁定「仅查看」。
3. 文件效果由 OS runner 强制执行。Windows 第一期用受限令牌 + ACL，只拦写，`enforcement` 为 `partial`。
4. OS 拒写后，仅查看 / 请求批准 / 替我审批允许模型对同一条 argv 申请一次性加宽，人批；工作区编辑拒绝升权。升权不改会话默认档。
5. 规格写齐三平台词汇与 `confine` 接口。Linux / macOS runner 在本规格实现中抛 `SANDBOX_UNAVAILABLE`，不假装已隔离。

### 后续规格（不在本文件实现）

能力面按 Harness 拉满，但拆开写：

2. `write` / `edit` 走同一套文件效果。
3. PTY 终端（长驻交互壳）。
4. code-exec / 子代理继承父会话策略。
5. 网络轴真强制执行（Linux `unshare-net` / 代理，或 Windows elevated + WFP）。本规格只留词汇。

## 2. 产品：五档审批

一个选择器，内部拆成文件沙箱 × 确认强度。Ask 是左边的模式，不是第六档。

| 档 | 文件模式 | 确认 | 升权 |
| --- | --- | --- | --- |
| 仅查看 | `read-only` | 联网工具与升权问人 | 问人 |
| 请求批准 | `workspace-write` | 越界意图 / 联网 / 危险命令 / 升权问人。越界写由 OS 拒，再走升权 | 问人 |
| 替我审批 | `workspace-write` | 只问危险命令（现有 auto） | 仍问人，不自动加宽 |
| 工作区编辑 | `workspace-write` | 不问 | 直接拒绝 |
| 完全权限 | `danger-full-access` | 不问 | 不经过沙箱拒写 |

Ask 模式：`resolvePreset` 忽略选择器，强制「仅查看」。想改档先退出 Ask。Ask 现有工具白名单保留，与 `read-only` runner 叠加。

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
    → 拒写：按档决定是否问人做一次性加宽
```

`SandboxManager` 不再在 `degraded` 后裸跑。它只调用 `resolvePreset`；不可用时把错误交给 UI 引导。

safety 继续做危险命令和受保护路径，不再假装自己是 OS 沙箱。升权不由 safety 发明策略，只问人。

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

interface ConfinedArgv {
  argv: string[]
  enforcement: SandboxEnforcement
  denialSignatures: readonly string[]
  runnerFailureRules: readonly RunnerFailureRule[]
}
```

本规格中 `resolvePreset` 写出的 `network` 恒为 `enabled`。`restricted` 留给后续网络规格；Windows ACL 不能声称已断网。

### 4.2 `resolvePreset`

输入：会话审批档、是否 Ask、工作区根、会话 id。输出：完整 `SandboxExecutionPolicy`。不 spawn。

### 4.3 `SandboxProvider.confine`

`confine(argv, policy: SandboxPolicy): ConfinedArgv`

只接受非 `danger-full-access` 的策略。有可用 runner 则返回包装后的 argv；否则抛 `SANDBOX_UNAVAILABLE`。禁止把未包装的 argv 当作成功结果返回。

消费方传入的是精确 argv，不是整段 shell 字符串。bash 形消费方传 `['bash', '-c', command]`（Windows 上解析到的 `bash.exe` 或 Git Bash）。

### 4.4 Windows ACL runner

移植 Harness 的写限制思路，自维护实现：

- `CreateRestrictedToken`（`WRITE_RESTRICTED` + 降特权）
- 工作区能力 SID + 每会话私有临时目录 SID
- 只拦写；读和套接字不拦
- `enforcement` 固定为 `partial`（Everyone 可写对象、NTFS 硬链接等缺口与 Harness 相同）
- 有 runner 且为 partial 时照常执行，结果和 UI 标明只拦写；不把 partial 当成 `UNAVAILABLE`

Linux（bwrap / Landlock）与 macOS（Seatbelt）在接口和探测链上写明；本规格实现抛 `SANDBOX_UNAVAILABLE`。

### 4.5 bash / pwsh 消费方

第一期只改官方名为 `bash` 的工具。Windows 上它解析到 `bash.exe`（Git Bash）；argv[0] 若是 `pwsh` 也走同一 `confine`，但不另交一个独立 `pwsh` 工具名。完全权限不调用 `confine`。其余先 `confine` 再 `spawn`。用 `runnerFailureRules` 与 `denialSignatures` 归因：先判 runner 失败，再判拒写。

插口优先包装官方工具的 execute（runtime 注入或扩展包装）。没有稳定注入点时，才用与 `patch-pi-shell` 同级的受控补丁，并在升级 `pi-coding-agent` 时列为必查项。不把 spawn 所有权改造成 Codex 式「全部经主进程 transform」。

### 4.6 放置

- `extensions/_shared/sandbox`：类型、`resolvePreset`、`confine` 接口、错误类型
- 同目录或并列的 local provider：Windows runner 选择与探测
- Electron 审批 UI / `approvalStore`：三档键扩为五档
- `SandboxManager`：改为 resolve + 不可用引导，删除 degraded 裸跑路径

## 5. 数据流与升权

1. 解析策略（Ask 则强制仅查看）。
2. safety 危险闸。替我审批只在此问危险命令。
3. 完全权限：原样 spawn。
4. 其余：`confine` 后 spawn。无 runner：不执行，引导。
5. 文件拒写：把当前 `mode` 和「可申请加宽」交回模型。模型必须重试同一条 argv，并给出 justification 与更宽 `mode`。只许加宽：
   - `read-only` → `workspace-write` 或 `danger-full-access`
   - `workspace-write` → `danger-full-access`
   改命令或变窄不算升权，消费方拒绝。
6. 仅查看 / 请求批准 / 替我审批：问人。允许则这次调用用更宽策略再 `confine`（或 full-access 裸跑）。会话默认档不变。
7. 工作区编辑：升权直接拒绝，不弹窗。
8. 升权被拒 / 取消 / 通道不可用：这次调用失败关闭，会话档不变。

禁止在工具结果里教模型换一种方式绕过沙箱。

## 6. 错误处理

| 情况 | 行为 |
| --- | --- |
| 无 runner | `SANDBOX_UNAVAILABLE`，命令未跑，UI 引导启用 runner 或改选完全权限 |
| runner 已包 argv 但 helper 未执行命令 | 基础设施错误，不当成拒写 |
| 文件拒写 | 走第 5 节升权表 |
| Windows partial | 执行，标明只拦写 |
| Ask 下改审批档 | resolve 仍强制仅查看 |

## 7. 测试

- `resolvePreset`：五档 × Ask 锁定；`network` 恒 `enabled`。
- `confine`：无 runner 抛 `SANDBOX_UNAVAILABLE`；`danger-full-access` 不得进入 `confine`。
- 升权：只许加宽；改命令 / 变窄拒绝；工作区编辑不弹窗。
- 归因：runner 失败与拒写签名不混用。
- `SandboxManager`：不存在 degraded 裸跑路径。
- Windows 真 ACL 套件仅在 win32 CI 运行。
- 非 Windows：POSIX 未实现 → `UNAVAILABLE`。

## 8. 非目标（规格 1）

- 不实现 Linux / macOS runner 本体。
- 不实现网络断网、代理、MITM。
- 不罩 `write` / `edit`、PTY、code-exec、子代理。
- 不引入 Cordis / 不直接依赖 DeepSeek npm 包。
- 不恢复 WSL2 + `srt` 作为 Windows 主路径。
- 不做 Guardian / 自动代批升权。
- 不把审批改回两轴两个选择器。

## 9. 与旧文档的关系

- `docs/superpowers/specs/2026-06-19-unified-sandbox-design.md`：WSL2 路线废弃，以本文件为准。
- `docs/superpowers/specs/2026-06-19-approval-policy-design.md`：三档「沙箱 scope + 确认」的产品假设改为本文件的五档融合；本规格落地前，现网仍是确认强度三档。
- `docs/superpowers/specs/2026-09-02-pi-codex-desktop-agent-design.md` 中 SandboxManager 的「能力不足则降级并遵守应用层 deny/ask」：本规格改为能力不足则失败关闭并引导，不再降级裸跑。
