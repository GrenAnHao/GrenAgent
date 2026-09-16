# SP-5 after-tool 写后回灌设计

- 日期：2026-06-26
- 状态：设计草案（brainstorming 产出），待审查 → writing-plans
- 范围：edit/write 后**自动跑诊断/LSP 并把结果回灌进 tool result**，补齐编码反馈闭环。纯扩展，复用现有 diagnostics/lsp。零 fork。
- 所属：零 fork 6 子项目之 SP-5。

## 1. 背景与目标

roadmap 当初把"LSP 写后自动诊断回灌"列为**暂缓**，理由是"Pi 扩展无 after-tool 钩子（仅 `tool_call` before）"。该结论基于更早版本——**0.79.10 已开放 `tool_result` 钩子且能 patch 结果**（见 §2）。

目标：当模型用 `edit`/`write` 改了文件，自动对受影响文件跑诊断（LSP 优先，回退项目 check），把诊断**追加进该 tool 的 result**，使模型在**同一轮**就看到自己引入的错误并修复，而不必等用户或下一轮手动 `diagnostics`。

## 2. 现状核验（锚点）

- 钩子可达（上游 0.79.10）：`pi-coding-agent/dist/core/extensions/types.d.ts:844` `on("tool_result", …ToolResultEventResult{content?,details?,isError?})`；注释（:701）"Fired after a tool executes. **Can modify result.**"；类型守卫 `isEditToolResult`/`isWriteToolResult`（:705/:706）。
- 结果被应用（编译实现）：`pi-coding-agent/dist/core/extensions/runner.js` `emitToolResult`：`currentEvent.content = handlerResult.content` 等。
- 可复用资产：
  - `extensions/diagnostics/`：`runChecks`（`runner.ts`）+ `resolveCommands`（`config.ts`）+ `parseTsc`/`parseEslintJson`（`parsers.ts`）→ 结构化 `Diagnostic[]`（`index.ts:30` 已成型）。
  - `extensions/lsp/`：语言服务器客户端（文件级诊断，比全项目 tsc 快）。

## 3. 设计

### 3.1 新扩展 `after-tool-feedback`（或并入 diagnostics）

挂 `pi.on("tool_result")`：

1. 用 `isEditToolResult(event)`/`isWriteToolResult(event)` 过滤；从 `event.input` 取被改文件路径。
2. 跑诊断（择一，可配置）：
   - **LSP 优先**（快、文件级）：复用 `lsp` 扩展能力对该文件取诊断。
   - **回退项目 check**：复用 diagnostics 的 `runChecks` + `parse*`，按文件过滤（diagnostics `index.ts:46` 已有 `paths` 过滤）。
3. 若有诊断 → 返回 `{ content: [...event.content, { type:"text", text: 渲染后的诊断 }] }`（追加，不丢原始结果）；可按需把 `isError` 置真（让模型更重视）。无诊断 → 返回 `undefined`（不改）。

### 3.2 控制项（runtime-config）

- `AFTER_TOOL_FEEDBACK`（默认开，且仅作用于 `edit`/`write` 工具）。
- `AFTER_TOOL_SOURCE`=`lsp|check|both`。
- 防抖/去重：同一文件短时间多次 edit 合并；只回灌"新增"诊断（与上次对比），避免噪声。
- 预算：诊断文本截断上限（仿 diagnostics 的 slice(0,200)）。

## 4. 数据流

```
模型 edit/write ──工具执行完 ──▶ tool_result 钩子
  → isEdit/isWrite? 取文件 → LSP/check 诊断（按文件）
  → 有诊断: 返回 {content:[原结果, 诊断]} patch  ──runner.js 应用──▶ 模型同轮看到并修
  → 无诊断: 返回 undefined（结果不变）
```

## 5. 错误处理 / 降级（fail-soft）

- 诊断命令/LSP 缺失或失败 → 返回 `undefined`，**绝不改/阻断** tool result。
- 诊断超时 → 放弃本次回灌（保留原结果）。
- 大量诊断 → 截断 + 标注"还有 N 条"。
- 只追加文本、不改文件本身（安全）。

## 6. 模式适配

- 纯数据变换，与运行模式无关；RPC/print/对话模式一致生效。
- 与 SP-3 真对话模式：对话模式精简扩展集**不含**本扩展（聊天无需写后诊断）；项目模式才启用。

## 7. 非目标

- 不阻断 edit/write（只回灌，不 block）。
- 不做跨文件全项目实时诊断流（用既有手动 `diagnostics` 工具）。
- 不替代 `tool_call`（before）安全闸——那是 safety 的职责。

## 8. 测试

- edit 引入类型错 → tool_result 被 patch 出诊断文本；无错 → 结果不变（返回 undefined）。
- LSP 路径与 check 回退路径各自生效。
- 诊断失败/超时 → 原结果完整保留（fail-soft 断言）。
- 防抖/去重：连续 edit 不刷屏。
- jiti smoke。

## 9. MVP 与增强

- MVP：`tool_result` 钩子 + edit/write 过滤 + diagnostics 复用回灌 + 默认仅 edit/write + 截断。
- 增强：LSP 文件级诊断优先、增量"仅新增诊断"、与 eval 工具回灌桥联动、可配置 isError 升级。
