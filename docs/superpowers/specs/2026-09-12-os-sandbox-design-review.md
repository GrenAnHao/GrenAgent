# OS 沙箱规格 1 · 评审意见

- 日期：2026-09-12
- 对象：`2026-09-12-os-sandbox-design.md`
- 结论：**方向正确，但存在 3 项阻断级缺口，不建议直接进入 writing-plans。**
- 处置（同日）：已按本意见修订规格 `2026-09-12-os-sandbox-design.md`。B1 / B2 已落地为具体契约；H2–H4 与低优先级项已并入 §4.4 / §4.6 / §5 / §6 / §7 / §8 / §9。
- B3 与 H1 已由用户裁决（2026-09-12）：
  - **B3 → 选「三平台同期」**：Linux（bwrap / Landlock）与 macOS（Seatbelt）**不再是**非目标，已进入本规格实现范围（§4.4.2 / §4.4.3），测试改为三平台各自 gating。
  - **H1 → 选「放开只读 bash」**：`ASK_TOOLS` 增列 `bash`，Ask 下可跑命令，OS `read-only` runner 是主防线而非纵深防御（§2 / §4.6 / 成功标准 8）。需同步回归与 plan 模式 `isSafeCommand` 的分层关系。

结论依据为对当前代码与 `@earendil-works/pi-coding-agent` SDK 的实测核对，非纸面推演。

---

## 0. 核对过的事实基线

| 事实 | 出处 |
| --- | --- |
| `bash` 工具入参只有 `{command, timeout}` | `dist/core/tools/bash.d.ts` `bashSchema` |
| 官方注入点：`createBashTool(cwd, {operations, spawnHook, commandPrefix, shellPath})` | `dist/core/tools/bash.d.ts:57-68` |
| `BashOperations.exec(command: string, cwd, {onData, signal, timeout, env})` —— 传入 **command 字符串**，非 argv | `dist/core/tools/bash.d.ts:31-38` |
| `spawnHook` 为**同步**函数，无法容纳异步 runner 探测 | `dist/core/tools/bash.d.ts:56` |
| 官方沙箱扩展示例即用 `operations` 覆盖 bash，且 Windows 上显式 notify 不支持 | `examples/extensions/sandbox/index.ts:132-227, 251-256` |
| 官方示例在失败时静默回退宿主 `localBash.execute` | `examples/extensions/sandbox/index.ts:218` |
| SDK 一等工具名含 `powershell`，但默认 built-ins 仅 `read/bash/edit/write` | `dist/core/tools/index.js:19-28`；`docs/sdk.md:522-523` |
| `user_bash`（`!`/`!!` 前缀）是独立于 `bash` 工具的执行通道，可注入 operations | `dist/core/extensions/types.d.ts:644-646, 828-831` |
| bash 实际在 **pi-worker 子进程**内执行，非 Electron 主进程 | `cli/src/pi-worker.ts:24-28` |
| Ask 模式当前**完全禁用** bash（白名单外一律拦） | `extensions/agent-mode/modes.ts:121-133` |
| 审批档持久化硬校验 `'ask'|'auto'|'full'`，否则 throw `INVALID_APPROVAL_POLICY` | `electron-agent/electron/app/piRuntimeService.ts:682-684` |
| `SandboxManager.prepare()` 另有 PTY 与子代理两个消费者 | `electron/app/shellService.ts:31`；`electron/app/subagentService.ts:67` |
| 旧 WSL2 沙箱代码已无残留（`sandbox-gate.ts`/`sandboxOn`/`SANDBOX_ENABLE` 均不存在） | `extensions/` 全量检索无匹配 |

---

## 1. 阻断级（必须修改）

### B1. 升权缺少模型侧协议，第 5 节闭环不可实现

规格要求「模型必须重试同一条 argv，并给出 justification 与更宽 mode」。但模型面对的 `bash` 工具只有 `{command, timeout}` 两个入参，没有任何字段能表达「升权 + justification」。规格也未定义通道形态：新工具、新增参数、还是 tool_result 里的结构化 payload。这是整个升权闭环的唯一入口。

**要求**：明确定义模型侧契约。建议形态：

```ts
request_bash_escalation({ command: string, justification: string, targetMode: FileSandboxMode })
```

由 `tool_call` 校验「与上一次被拒的 command 逐字节相同」+ justification 非空且达最小长度，再走 `ctx.ui.select` 问人。

### B2. `confine` 的注入点与 argv 假设错位（§4.3 vs §4.5）

- 官方 seam 交付的是 **command 字符串**，不是 argv。argv 只在「我们自己的 `operations` 实现内部」才存在。规格把 `confine(argv)` 的调用方写成通用消费方，概念层级错位。
- 一旦自行构造 argv，就必须**自己 spawn**，无法再复用 `createLocalBashOperations()`——即我们事实上取得了 spawn 所有权。这与 §4.5 末句「不把 spawn 所有权改造成 Codex 式『全部经主进程 transform』」直接冲突，需改写为明确取舍。
- `spawnHook` 是同步的，撑不起异步 runner 探测；且它只能返回 command 字符串，把模型可控的命令串再嵌进一层 shell 字符串会**引入命令注入面**。规格应显式禁止该方案。

**要求**：锁定唯一 seam 为 `createBashTool(cwd, { operations }) + pi.registerTool`，并同步删除 §4.5 的「受控补丁」兜底——已确认存在官方稳定注入点，而 `cli/scripts/patch-pi-shell.mjs` 是对 `dist/utils/shell.js` 的字符串替换、依赖 `isLegacyWslBashPath` marker，属脆弱分支，不应保留为兜底路径。

### B3. 失败关闭会在非 Windows 上彻底禁掉 bash（§1 成功标准 1 + 5）

Linux/macOS runner 抛 `SANDBOX_UNAVAILABLE` 且不执行 → 除「完全权限」外所有档位无法运行 bash。而代码明确支持非 Windows（`shellService.ts` 按 platform 选 `powershell.exe`/`bash`）。这不是「引导用户启用 runner」能化解的，等于 macOS/Linux 桌面端功能残废。

**要求**：明确声明本规格是否仅面向 Windows 桌面端。若否，须给出过渡策略（如 POSIX 允许 bwrap/Landlock 探测，或明确「非 Windows 暂不发布」并同步到产品预期）。

---

## 2. 高优先级（建议修改）

- **H1 · Ask 锁定是空操作。** Ask 模式当前完全禁用 bash（`modes.ts:124-133`，注释明写「含 bash」）。§2「Ask 强制仅查看、与 read-only runner 叠加」在现状下无事可做。若意图是「Ask 下新放开只读 bash」，那是行为扩张，须写入成功标准，并厘清与 plan 模式 `isSafeCommand` 命令白名单的关系。
- **H2 · 五档落地的持久链未列全。** 除 UI 与 `approvalStore` 外，`piRuntimeService.writeApprovalPolicy` 的白名单校验与 `agent_set_approval` IPC 必须同步改造，否则新档位会被 `INVALID_APPROVAL_POLICY` 挡下。
- **H3 · 改 `SandboxManager` 会波及范围外消费者。** `prepare()` 现被 PTY 终端（`shellService`）与子代理取消（`subagentService`，仅作路径校验）调用。若改为「无 runner 即失败关闭」，非 Windows 上会连带打断这两个本规格范围外的功能。需隔离：新策略只约束 bash 路径，或为 PTY/子代理保留独立校验入口。
- **H4 · 类型缺口与归因脆弱。**
  - `RunnerFailureRule` 全文未定义；`SandboxProvider` 仅有一处方法签名、无接口声明。
  - `denialSignatures` 靠输出文本判拒写：命令回显同类文字会误触发升权，非英文 locale 又会漏判。建议改用结构化通道（runner 专用退出码 / 标记文件 / sidecar 状态），signature 仅作兜底。
  - `ConfinedArgv` 只有 argv，缺 cwd/env/stdio 契约；Windows helper 需转发 stdout/stderr、退出码、abort、超时 kill（注意 `process.kill(-pid)` 在 Windows 无效），且「每会话私有临时目录」的创建与清理责任未定义。

---

## 3. 低优先级（仅供参考）

- §1「在 Electron 主进程内嵌 SDK 里 spawn」不准确：实为 `cli/src/pi-worker.ts` 起 pi-worker 子进程执行，插口在 extension 侧。
- 「不另交一个独立 `pwsh` 工具名」可成立（`powershell` 默认未启用），但应写成显式断言 + 「将来启用需回归」的要求。
- `user_bash`（`!`/`!!` 前缀）是绕过 `bash` 工具的并行执行通道，官方示例专为它挂了 `pi.on("user_bash", () => ({operations}))`；规格未提，需明确禁用或同样接管。
- §2 表格的「联网问人」未标注为确认态而非强制态，与 §4.1「network 恒为 enabled」并读易被误认为已断网。
- §9 可补一句「旧 WSL2 沙箱代码已无残留，无需迁移」，避免实现期误找 `sandbox-gate.ts`。
- 建议在 §3 引用官方 `examples/extensions/sandbox/index.ts:218` 的 `if (!sandboxEnabled || !sandboxInitialized) return localBash.execute(...)` 作为明令禁止的静默降级反例——它正是本规格要纠正的典型形态。
- 实现前需实测：pi-worker 内 `ctx.ui.select` 是否可达 Electron 的 `PromptRequestCard`。若不可达，五档中三档的「问人」会退化为拒绝或自动放行，须预备兜底。

---

## 4. 建议的处置顺序

1. 补 B1 的模型侧升权协议 → 否则第 5 节无法进入计划拆分。
2. 锁定 B2 的 seam（`operations`），删除补丁兜底，补 `ConfinedArgv` 的进程契约。
3. 就 B3 与 H1 做一次产品裁决（Windows-only？Ask 是否放开 bash？），两项都会改变成功标准。
4. H2/H3 作为落地清单补进 §4.6。
