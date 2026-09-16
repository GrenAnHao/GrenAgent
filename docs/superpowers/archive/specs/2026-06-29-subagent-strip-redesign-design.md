# 子代理内联横条重设计（SubAgentInline / ConvStrip）

- 日期：2026-06-29
- 范围：tauri-agent 主对话里 `spawn_agent` 的内联横条（折叠态 + 展开态）
- 状态：设计已逐节获用户批准（视觉伴侣评审），待规格审查后进入实现计划

## 1. 背景与问题

当前每个内联子代理用 `ConvStrip` 渲染一条横条：`状态图标 + bot + 「子代理 #N」 + chip(任务原文) + meta + 操作 + 展开箭头`。
实际使用中（典型场景：一次 spawn 出多个"反审查"子代理）暴露三个问题：

1. chip 把整段任务 prompt 的 **Markdown 原文**（`## 角色`、`**...**`）塞进等宽字体框，自然语言用 code 字体，观感杂乱。
2. 同一批子代理任务正文高度重复，唯一区别（角色）被埋在长串中间，**无法一眼区分谁是谁**。
3. 长文本被截断，真正有用的信息看不到。

## 2. 目标设计

### 2.1 折叠态（双行，方向 B+）

```
[状态图标] [bot] 子代理 #N · {角色}                         [模型 chip] [展开箭头]
           {第二行}
```

- **第一行**：左侧状态图标（运行=转圈/完成=勾/出错=叉，带色）→ bot 图标 → `子代理 #N` → `·` → **角色短标签**（普通字体，非 code）。右侧只放 **模型**（等宽小 chip，如 `gpt-5.3-codex`）+ 展开箭头。
- **第二行**（灰、单行省略号）：
  - 运行中：`第 N 步 · {当前动作}`（实时刷新，当前动作可带流光动画）。
  - 终态：`{状态 · 步数 · tokens} · {摘要}`（见 D1）。
- 状态只靠左侧图标的图形 + 颜色表达；**不再在右侧放"运行中/已完成/出错"文字**。

### 2.2 角色短标签提取

- 主规则：识别任务里的 `## 角色 ... **X**` 模式，取 `X`。
- 回退：取任务首个非空行，剥离 Markdown 标记后截断。
- 提取仅用于显示；完整 prompt 保留在展开区。

### 2.3 模型

- 位置：第一行最右（展开箭头左侧），等宽小 chip。
- 来源：终态用 `subAgentStats(result).model`；运行中用 registry 行 `SubAgentItem.model`（需 agentId，见 D2）。去掉 provider 前缀（已有逻辑）。

### 2.4 停止键（方案 A：状态图标悬停即停止）

- 仅运行中。鼠标悬停在整行上时，左侧"转圈"状态图标原地变为红色停止方块，点击调用 `pi.abort` / `pi.subagentCancel`。
- 不悬停时仍是转圈图标；终态为勾/叉，不可点。
- 零额外元素，"看状态的地方就是停止的地方"。

### 2.5 展开态（方向 E1：结果优先 · 精简）

点展开箭头后，下方缩进区（左竖线）：

1. **统计头**：`模型 · 步数 · tokens · 用时` + 右侧醒目按钮「打开完整对话」（去右坞看完整流式回放）。
2. **结果区**：
   - 终态：最终结果（Markdown 渲染）。
   - 运行中：实时当前动作 / 最近几步（轻量），引导去右坞看完整。
3. **指令**：默认折叠，标题「查看指令」可展开（角色已在行上，完整 prompt 少看）；展开后 Markdown 渲染（不再等宽原文）。

完整逐字流式回放始终在右坞（`SubAgentLogBody` / `SubAgentConversation`），内联只做快览，避免重复与卡顿。

## 3. 数据来源与可行性

- registry 行 `SubAgentItem`（`pi.subagentList`）运行期**增量写入** `transcript` 与 `model`、`status`，右坞 `SubAgentLogBody` 已按 agentId 每 2.5s 轮询。本设计复用同一数据源：
  - 实时第二行：解析增量 transcript 的**最新一步**（最近的 `tool_execution_start` 工具名+关键参数，或最新 assistant 文本首句）→ `第 N 步 · {动作}`。为避免卡顿，运行中只解析尾部，不全量解析。
  - 运行中模型：取 registry 行 `model`。
- 终态统计沿用 `subAgentStats` / `subAgentStepCount` / `subAgentFinalText`（仅终态解析一次）。

## 4. 待确认项（已给默认值）

- **D1 终态第二行内容**：默认 `{状态 · 步数 · tokens} · {任务摘要(纯文本)}`；出错时若有错误信息则摘要换为错误首句，否则用任务摘要。
- **D2 实时边界**：默认仅在能拿到 agentId 时实时（后台 spawn 运行中即有）。前台内联 spawn 在结束前可能无 agentId，此时第二行回退「运行中…」、模型待结束才显示；**本期不额外打通前台 spawn 尽早暴露 agentId**（YAGNI，后续可单独做）。

## 5. 影响面（低）

- `tauri-agent/src/features/chat/SubAgentInline.tsx`：折叠态双行、角色提取、模型、实时第二行（轮询 hook）、停止键接线、展开 E1。
- `tauri-agent/src/features/chat/conv/ConvStrip.tsx`：扩展为支持双行 / 第二行槽 / 模型槽（或新增 `ConvStrip` 变体；ConvStrip 实际仅 SubAgentInline 与 preview 在用，改动安全）。
- `tauri-agent/src/features/chat/conv/StatusGlyph.tsx`：运行态在行 hover 下变红色停止键（需要把"是否可停止 + onStop"传入，或由父层覆盖）。
- `tauri-agent/src/features/panels/subagentUtils.ts`：新增角色提取、运行中"最新一步"摘要解析；复用既有 stats。
- 可能新增一个轮询 hook（提炼自 `SubAgentLogBody` 的 registry 轮询）供折叠态实时第二行使用。
- `SubAgentGroupInline.tsx`（并行/链式组的行）暂不在本期范围；若需要一致化，另列跟进。
- `preview.tsx` 同步更新 ConvStrip 示例；`ConvStrip.test.tsx` / `SubAgentInline.test.tsx` 跟随调整。

## 6. 验收

- 折叠态：四个同批反审查子代理能一眼区分角色；无 Markdown 原文外泄；模型在最右。
- 运行中：第二行实时刷新当前步骤；左图标 hover 变停止可中止。
- 终态：第二行显示状态/步数/tokens/摘要；展开 E1 显示结果 + 打开完整对话，指令默认折叠。
- jsdom 测真实布局有限，行为以手动验收为准；单测覆盖角色提取、最新一步摘要解析等纯函数。
