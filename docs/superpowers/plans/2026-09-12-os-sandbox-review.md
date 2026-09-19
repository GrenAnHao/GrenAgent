# OS 沙箱规格 1 · 实现计划评审

- 日期：2026-09-12
- 对象：`docs/superpowers/plans/2026-09-12-os-sandbox.md`
- 上游：`docs/superpowers/specs/2026-09-12-os-sandbox-design.md`
- 结论：**结构与节奏可用，但有 3 项阻断级缺陷（2 项必然编译失败/行为错、1 项交付必然不可用），5 项高优先级。**
- 处置（同日）：已按本意见修订计划 `2026-09-12-os-sandbox.md`。P1 / P2 / P3 与 H1–H5 全部落地；新增任务 13（helper 构建与进包）、任务 14（三平台 CI 作业）；自检表补齐并新增「cwd 取 ExtensionContext」「runner 缺失不误判」「规格 2–5 负向断言（任务 11）」三行。

所有判断均基于对当前代码与 `@earendil-works/pi-coding-agent` 类型定义的核对。

---

## 0. 已核对为「准确」的部分

| 计划声称 | 核对结果 |
| --- | --- |
| `_shared/approval.ts` 现状三档、`currentCwd` 来自 `./workspace-context.js` | ✅ 一致（第 4、6 行） |
| 测试名 `has zh labels for all 3` | ✅ 存在（`_shared/approval.test.ts:45`） |
| `builtinRules.ts` 有 `GUARDS` / `ASK_EXTRA` / `BUILTIN_RULES` | ✅ 一致（第 16、22、34 行），`GUARDS[0]` 确为 protected-path |
| `builtinRules.test.ts` 有 `facts(preset, flags)` helper | ✅ 存在（第 10 行），计划新增测试可直接用 |
| `ApprovalPreset` 三处：types.ts:12、desktop-control.ts:29、safety/index.ts:31 | ✅ 全部为 `'ask'|'auto'|'full'` |
| `safety/index.ts:124` 把档塌成三档 | ✅ 存在，正是任务 9 要改的 |
| `extensions/index.ts` 的 `allExtensions` / `namedExtensions`，`approval` 在第 83 / 121 行 | ✅ 可插入 |
| `cli/src/extension-profile.ts:19` `CORE_ALWAYS_ON` | ✅ 存在 |
| `sandboxManager.test.ts` 有 `marks degradation without changing the requested profile` | ✅ 第 31 行 |
| `agent-mode/modes.test.ts:109` 断言 ask 拦某批工具 | ✅ 存在，任务 10 可改 |
| `extensions/package.json` 有 `typebox` | ✅ 第 26 / 40 行 |
| 工具 `execute` 的第 5 参 `ctx` 有 `cwd` / `hasUI` / `ui.select` | ✅ `types.d.ts:372` + `ExtensionContext`（211/215/217） |

---

## 1. 阻断级（必须改）

### P1 · 任务 8 用了 `ExtensionAPI` 上不存在的成员

`pi.cwd` 与 `pi.sessionManager` **都不存在**。核对 `dist/core/extensions/types.d.ts`：全文 `cwd: string;` 只出现在 217 / 327 / 389 / 397 / 406 / 652 行，全部属于 `ExtensionContext`、各类事件 context 与 `ProjectTrustContext`，`ExtensionAPI`（906 行起）没有 `cwd`、也没有 `sessionManager`。

后果：
- `pi.sessionManager?.getSessionId?.()` 直接编译失败（`?.` 救不了不存在的属性）。
- `pi.cwd ?? process.cwd()` 为通过编译只能退回 `process.cwd()`，**多工作区 / 多会话下 `getPolicy()` 会用错 cwd**，沙箱把错误的工作区当可写根。

正确来源（已核实）：
- `ToolDefinition.execute(..., ctx: ExtensionContext)`（`types.d.ts:372`）→ `ctx.cwd`(217)、`ctx.hasUI`(215)、`ctx.ui`(211)、`ctx.sessionManager`(219)。
- `ReadonlySessionManager` 明确含 `getSessionId()`：`dist/core/session-manager.d.ts:140`。

修法：`session_start` 里把 `ctx.cwd` 与 `ctx.sessionManager.getSessionId()` 存进闭包；`session_shutdown` 用存的 id；`bash_escalate.execute` 继续用 `ctx.cwd`。另建议把 `tsc --noEmit` 提升为每任务的硬门槛（现计划只在 `createBashTool` 那句提了一句）。

### P2 · `registerTool` 的类型口径不能交给编译器

- `registerTool(tool: ToolDefinition)`（`types.d.ts:944`）；`createBashTool()` 返回 **`AgentTool`**（`bash.d.ts:85`）；`createBashToolDefinition()` 返回 **`ToolDefinition`**（`bash.d.ts:84`）——后者才是 `registerTool` 的一等公民。
- 计划写「若类型不兼容 `registerTool`，改用 `createBashToolDefinition`。以能通过 tsc / 单测为准」。这是把设计决策交给编译器：若 `AgentTool` 结构上恰好兼容，就会选错路径并丢掉 `renderCall` / `renderResult` 与 label 语义。

修法：直接钉死 `createBashToolDefinition(cwd, { operations })`（官方 `examples/extensions/sandbox/index.ts` 用 `createBashTool` + 展开是权宜写法，不是规范）。

### P3 · Windows helper 的构建与打包没有落点

- 任务 6 要求 CI 用 `cl` / `gcc` 编 `helper.c` → `extensions/_shared/sandbox/windows/bin/pi-sandbox-win.exe`，并「加入 `.gitignore`」。
- **打包漏洞**：`electron-agent/electron-builder.yml` 的 `files` 只有 `dist/**`、`out/**`、`package.json`，`asarUnpack` 也不含 extensions。这个 exe **不会进产物** → 生产环境必然 `SANDBOX_UNAVAILABLE` → Windows 上受限档位全废。
- 计划没有任何任务负责：CI 编译器准备、产物进包路径、`asarUnpack` 条目、「编不出来时的发布决策」。

修法：二选一并写成任务——(a) 预编译 exe 入仓（免 CI 编译器，最省事）；(b) 新增任务改 electron-builder 的 `files` / `asarUnpack`，并加一条「产物内 helper 存在」的冒烟。同时需确认 extensions 目录整体如何进入打包产物。

---

## 2. 高优先级（建议改）

- **H1 · 归因漏掉 spawn ENOENT。** `attributeRun` 只在「退出码命中 ∧ 签名命中」时判 `runner-failure`。runner 可执行文件缺失时 `spawn` 走 `error` 事件，出口是 `exitCode: null` + 空 stderr；计划把它兜成 `code = 1` → 归因为 `command`。结果是「runner 没装」被当成「命令自己失败」，用户拿不到引导。应把 `spawn` 的 `error`（ENOENT / EACCES）单独成类，直接判 `runner-failure`。
- **H2 · 任务 3 的代码块与验收测试自相矛盾。** 步骤 1 要求「stdout 回显 `erofs` + exit 1 → `command`」，但步骤 3 的 `attributeRun` 把 stdout+stderr 拼一起匹配签名，会判成 `denial`，测试必红；步骤 3 末尾才补一句「签名兜底只看 stderr」。应把修正直接写进代码块（拆 `stdoutText` / `stderrText`），别让实现者先写错再改。
- **H3 · 三平台 CI 只有 gating，没有作业。** 任务 12 用 `PI_SANDBOX_LIVE=1` + `skipIf`，但全计划没有任何任务创建/修改 CI 工作流。规格 §7 要求「三平台各自必跑」，现状是「CI 默认绿 + 没人设变量」＝永远不跑。需补一个任务：新增 CI 作业（win32 编 helper、linux 装 bwrap、darwin 自带 sandbox-exec）并设置该变量。
- **H4 · Ask 档升权判定用错了键。** `bash_escalate` 用 `getApprovalPolicy(cwd) === "workspace"` 拒升权，但规格按**解析后的 mode** 裁决：Ask 下 mode 被强制 `read-only`，按规格仍应允许问人升权。Ask + 审批档=`workspace` 的组合下计划会误拒。应改用「`pending.mode` + 审批档」组合判断。
- **H5 · 覆盖自检表那行「不实现规格 2–5 ｜ 未列任务」等于没有验证点。** 至少补负向断言（如 `confine` 不处理网络、`write`/`edit` 不进 `confine`），否则回归时无从发现越界。

---

## 3. 中 / 低优先级

- 任务 4 的 `bwrapArgv` 在 `read-only` 分支 push `--bind /dev/null /dev/null` 语义可疑，且 read-only 下**没有任何可写目录**——Linux 上 `mktemp` / `git` 等需要临时目录的工具会直接失败。规格 §4.4 明确每会话临时目录在 Linux 下也是 bind 放行项，read-only 分支应同样 bind 一个空临时目录。
- 任务 5 的 `denialSignatures: ["operation not permitted", "sandbox"]` 过宽——`sandbox` 字面量极易被普通输出命中，与「结构化优先、签名兜底」冲突。建议只留内核拒绝串并配合 `denialExitCodes`。
- 任务 8 的 `bash_escalate` 在 `targetMode === "danger-full-access"` 时直接 `operations.exec(...)`，依赖 `isConfined(policy.mode)` 才绕开 confine；建议补一条测试钉死「`full` 档下无 pending，直接拒绝」。
- `extensions/_shared/sandbox/index.ts` 同时出现在任务 8 与任务 11，职责重叠，建议只归一处。
- 测试命令里的 `safety/index.test.ts` 请确认存在（我只验证了 `safety/index.ts` 有 `collectFacts`）。
- 任务 9 的 `workspace: [GUARDS[0]]` 依赖数组下标，脆弱；建议给规则命名常量后按名引用。

---

## 4. 建议的修复顺序

1. P1（改 `ctx` 取值 + 加 tsc 门槛）→ 不动这个，任务 8 直接编译失败。
2. P2（钉死 `createBashToolDefinition`）→ 与 P1 同批改。
3. P3（helper 打包路径）→ 决定入仓还是改 electron-builder，建议先做，因为它可能反推文件结构。
4. H1 / H2 / H4（逻辑正确性）→ 任务 3、7、8 内部修订。
5. H3（CI 作业）→ 补一个任务。
