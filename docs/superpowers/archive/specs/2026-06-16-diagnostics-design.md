# 子项目 D.2：诊断反馈（设计/规格）

- 日期：2026-06-16
- 状态：草案 — 已实地核验（npm 运行时 `@earendil-works/pi-coding-agent@0.79.x`），待用户审查
- 主题：工具 `diagnostics({paths?})` 运行项目 check 命令（tsc/eslint 等），把输出解析成结构化诊断回灌
- 载体：纯新扩展 `extensions/diagnostics/`
- 上游总览：`docs/superpowers/specs/2026-06-16-pi-enhancement-roadmap-design.md` §4.D.2

> 锚点约定：`types.d.ts` = `.../dist/core/extensions/types.d.ts`；扩展源码 = `extensions/<name>/`。

## 0. 实地核验要点（修正总览的隐含假设）

| 议题 | 核验结论 |
|---|---|
| 扩展怎么跑 shell？ | 现网扩展统一用 **`node:child_process`**（`code-review/git.ts:3-20` 的 `execFile`、`multi-agent/runner.ts:4,224` 的 `spawn`、`checkpoint/snapshot.ts:3,49`）。`ExtensionAPI.exec(command,args,opts)` 存在（`types.d.ts:878-879`）但挂在工厂参数 `pi` 上、**不在**工具 `execute` 的 `ctx: ExtensionContext`；可经闭包用 `pi.exec`，但为与现网一致 **MVP 用 `execFile`** |
| `.pi/settings.json` 怎么读？ | `_shared/runtime-config` **不读** settings.json（只读 `PI_RUNTIME_CONFIG`+env）。需直接 `readFileSync(<cwd>/.pi/settings.json)` 或 `SettingsManager.create(ctx.cwd).getSettings()`（`index.d.ts:18`）。现 `Settings` 接口无 diagnostics 字段（`settings-manager.d.ts:58-100`）→ 用自定义键 |
| 需要 LSP 吗？ | MVP 不需要，跑 check 命令解析输出即可（LSP 归增强） |

## 1. 目标与范围

### 1.1 MVP
- 工具 `diagnostics({ paths? })`：运行项目配置或自动探测的 check 命令，把 stdout/stderr 解析成 `{ file, line, col?, severity, message, source }[]` 结构化返回。
- 命令来源优先级：`<cwd>/.pi/settings.json` 自定义键 `diagnostics.commands` → 自动探测（`tsconfig.json`→`npx tsc --noEmit`；`.eslintrc*`/`eslint.config.*`→`npx eslint .`）。
- 用 `node:child_process.execFile`，`cwd = ctx.cwd`，接 `signal` 支持中止。

### 1.2 成功标准
1. 在含 TS 错误的项目调 `diagnostics`，返回带 file/line/message 的结构化结果。
2. 命令缺失/未配置 → 明确报错或探测提示，不阻断会话。
3. `paths` 传入时只对相关文件过滤结果（命令仍整体跑，结果按 path 前缀过滤；MVP 简单实现）。

### 1.3 不在范围（增强）
- 真正的 LSP 客户端（启动 language server，文件级实时诊断，对齐 MiMo `lsp`）。
- `tool_execution_end`/`turn_end` 在 edit/write 后自动诊断回灌。
- 增量/按文件诊断。

## 2. 代码依据（实地核验）

| 能力 | API / 锚点 |
|---|---|
| 跑 shell | `node:child_process` `execFile`（现网 `code-review/git.ts:3-20`：`execFile(cmd,args,{cwd,maxBuffer})`） |
| 备选跑 shell | `pi.exec(command, args, options?): Promise<ExecResult>`（`types.d.ts:878-879`，工厂闭包可用） |
| 工具注册/返回 | `registerTool(ToolDefinition)`（`types.d.ts:335-361,840`）；`execute(toolCallId, params, signal, onUpdate, ctx)` 返回 `{ content:[...], details }`（现网 `web-fetch/index.ts:102-144`） |
| 中止 | `execute` 的 `signal: AbortSignal`（传给 execFile 的 `signal`） |
| cwd | `ctx.cwd`（`types.d.ts:216`） |
| 读 settings | 直接 `readFileSync(join(ctx.cwd,".pi","settings.json"))` 或 `SettingsManager.create(ctx.cwd)`（`index.d.ts:18`） |
| 配置开关 | `_shared/runtime-config` `getConfig` |

## 3. 架构与组件

`extensions/diagnostics/`：
- `index.ts` —— 工厂。注册 `diagnostics` 工具（+ 可选 `/diagnostics` 命令）。
- `runner.ts` —— `runChecks(cwd, commands, signal): Promise<RawCheck[]>`，`execFile` 包成 `Promise`，捕获非零退出码仍读取 stdout/stderr（tsc/eslint 出错时退出码非 0）。
- `parsers.ts` —— 纯函数：`parseTsc(output)`、`parseEslint(output)` → 统一 `Diagnostic[]`。可独立单测。
- `config.ts` —— `resolveCommands(cwd)`：读 `.pi/settings.json` 自定义键 → 否则自动探测。

## 4. 数据流
```
diagnostics({paths?})
  → commands = resolveCommands(ctx.cwd)            // settings 自定义键 → 自动探测
  → 无命令：返回「未配置 check 命令」+ 探测建议（fail-soft）
  → raw = runChecks(ctx.cwd, commands, signal)     // execFile，读 stdout/stderr
  → diags = parsers(raw)                           // {file,line,col?,severity,message,source}
  → paths 过滤（可选）
  → return { content:[{type:"text", text: 摘要}], details:{ diagnostics: diags } }
```

## 5. 解析规则（MVP 覆盖 tsc + eslint）
- **tsc**：`path(line,col): error TSxxxx: message`（`--pretty false` 保证稳定格式）。
- **eslint**：`-f json` → 解析 JSON（最稳）；或 stylish 文本兜底。
- 统一 `severity: "error" | "warning" | "info"`，`source: "tsc" | "eslint" | <cmd>`。

## 6. 错误处理（fail-soft）
- 命令不存在（`ENOENT`）→ 返回明确错误（「未找到 tsc/eslint，请配置 diagnostics.commands」），不抛崩。
- 命令超时 / `maxBuffer` 溢出 → 截断 + 提示。
- 解析不出任何条目但有输出 → 原样附 raw 摘要（避免「明明有错却报无」）。
- 中止（signal）→ 终止子进程，返回已收集部分。
- Windows：命令经 `npx`/`cmd` 兼容；`execFile` 用 `shell:false`，命令数组化避免注入。

## 7. 配置
- `.pi/settings.json`（项目）自定义键：`{ "diagnostics": { "commands": [["npx","tsc","--noEmit","--pretty","false"], ["npx","eslint",".","-f","json"]] } }`。
- `getConfig`：`DIAGNOSTICS_ENABLED`（默认开）、`DIAGNOSTICS_TIMEOUT_MS`（默认 120000）。

## 8. 测试
- `parsers.test.ts`：tsc/eslint 样例输出 → 结构化条目（多文件、多严重度、无错为空）。
- `config.test.ts`：settings 自定义键优先于探测；探测顺序（tsconfig→tsc，eslintrc→eslint）。
- `runner.test.ts`：跑一个必失败的小命令，验证非零退出仍读输出 + signal 中止。
- jiti smoke。

## 9. 实现文件清单
| 文件 | 职责 |
|---|---|
| `extensions/diagnostics/index.ts` | 工厂 + 工具 |
| `extensions/diagnostics/runner.ts` | execFile 封装 |
| `extensions/diagnostics/parsers.ts` | tsc/eslint 输出解析（纯函数） |
| `extensions/diagnostics/config.ts` | 命令解析（settings/探测） |
| `*.test.ts` | 单测 |
| `extensions/package.json` | 追加 `./diagnostics/index.ts` |

## 可选增强（YAGNI）
- LSP 客户端（持久 language server，文件级实时诊断）。
- `tool_execution_end` 在 edit/write 后自动诊断改动文件并回灌（`types.d.ts` 的 `tool_execution_end` hook）。
- 更多 linter（ruff/golangci-lint…）解析器即插即用。

## 规格自检（2026-06-16）
- [x] 无占位；exec 机制与 settings 读取已据核验定稿
- [x] MVP（tsc/eslint 解析）与增强（LSP/自动回灌）边界清晰
- [x] 范围可单一实现计划覆盖
- [x] fail-soft + Windows 兼容明确

## 代码核对修订（2026-06-16，实地核验 v1，来自 D 区只读审计）
- [x] exec 机制属实：现网 `execFile`/`spawn`（`code-review/git.ts:3-20`、`multi-agent/runner.ts:4,224`、`checkpoint/snapshot.ts:3,49`）；`pi.exec` 备选（`types.d.ts:878-879`）
- [x] `ctx`（工具 execute）无 exec、`exec` 在 `pi`（ExtensionAPI）上——已据此选 execFile
- [x] settings.json 不经 runtime-config：需直读或 `SettingsManager.create`（`index.d.ts:18`）；`Settings` 无诊断字段（`settings-manager.d.ts:58-100`）→ 自定义键
- [x] 工具签名/返回属实：`types.d.ts:335-361`、`web-fetch/index.ts:102-144`
