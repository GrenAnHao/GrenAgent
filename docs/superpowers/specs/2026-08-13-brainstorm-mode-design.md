# Brainstorm 模式 — 设计规格

**日期：** 2026-08-13  
**状态：** 已批准，待实现

---

## 1. 背景与目标

GrenAgent 现有 Agent / Ask / Debug / Plan 四种模式（由 `agent-mode` 扩展管理）。Superpowers 头脑风暴技能（brainstorming skill）目前使用外部浏览器的 HTTP + WebSocket 服务来展示视觉伴侣，与 GrenAgent 体验割裂。

**目标：** 在现有 `agent-mode` 体系中新增 `brainstorm` 模式，让 AI 在头脑风暴流程中：
- 通过已有的 `show_visual` / `read_visual_choice` 工具直接在软件内呈现可交互的视觉内容
- 使用只读工具集（防止头脑风暴时意外改动文件）
- 体验与原生 GrenAgent 界面浑然一体，无需外部浏览器

---

## 2. 决策记录

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 架构方式 | **扩展现有 agent-mode** | 复用全部基础设施（工具限制、状态持久化、模式切换器 UI），改动最小 |
| 触发方式 | **工具栏按钮**（模式选择器） | 与现有 Agent/Ask/Debug/Plan 切换方式一致，无需学习新操作 |
| 视觉伴侣位置 | **自适应**（auto 模式） | 简单选项内联，复杂原型/图表右侧面板，与已有 VisualCard/VisualPanel 直接复用 |
| 模式标识 | **输入框模式徽章** | 轻量，与现有 Plan/Debug 模式徽章一致，不改变主界面布局 |

---

## 3. 架构概览

```
触发：用户在模式选择器点击「Brainstorm」
         ↓
前端 ModeAction → pi.setMode(workspace, 'brainstorm')
         ↓
sidecar agent-mode 扩展 applyMode('brainstorm')
  · 工具集 = BRAINSTORM_TOOLS（只读 + visual-companion 工具）
  · 注入头脑风暴 system prompt（fable-behavior brainstorm.md）
  · pushStatus('agent-mode', 'brainstorm') → 前端回读高亮
         ↓
AI 在头脑风暴中调用 show_visual(html)
         ↓
VisualCard（内联，简单选项）或 VisualPanel（右侧，复杂原型）
         ↓
用户点击 → read_visual_choice() resolve → AI 继续
```

---

## 4. 扩展层改动（`extensions/agent-mode/`）

### 4.1 `modes.ts` — 新增 brainstorm 模式

```typescript
export type AgentMode = "agent" | "ask" | "debug" | "plan" | "brainstorm";

export const AGENT_MODES: readonly AgentMode[] = [
  "agent", "ask", "debug", "plan", "brainstorm"
] as const;

// brainstorm 工具集 = ask 只读集 + visual-companion 工具
export const BRAINSTORM_TOOLS: readonly string[] = [
  ...ASK_TOOLS,
  "show_visual",
  "read_visual_choice",
];

export function toolWhitelist(mode: AgentMode): readonly string[] | undefined {
  if (mode === "ask") return ASK_TOOLS;
  if (mode === "plan") return PLAN_TOOLS;
  if (mode === "brainstorm") return BRAINSTORM_TOOLS;
  return undefined;  // agent/debug: 不限制
}
```

**`gateToolCall`** 新增 brainstorm 分支：白名单（`BRAINSTORM_TOOLS`）之外一律拦截，错误提示引导用户切回 Agent 模式。

**`modeBadge`** 新增：`brainstorm` → `"Brainstorm"`

**`modeLabel`** 新增：`brainstorm` → `"头脑风暴"`

### 4.2 `index.ts` — switchMode 清理状态

`brainstorm` 与 `plan` 一样属于受限模式，切离时清除专属子状态（无额外子状态，此处与其他受限模式保持一致即可）。

---

## 5. fable-behavior 层（`extensions/fable-behavior/`）

### 5.1 新增 `prompts/modes/brainstorm.md`

System prompt 指示 AI 在 brainstorm 模式下的行为：

```markdown
# Brainstorm 模式

你正在与用户进行头脑风暴。遵循以下原则：

## 核心原则
- **每次一个问题** — 不要同时抛出多个问题
- **视觉优先** — 当内容是视觉的（原型/布局/架构图/选项对比），
  使用 show_visual + read_visual_choice；文字问题直接回复
- **不实现** — 不写代码、不修改文件、不执行命令；
  只探索想法、提出方案、展示原型
- **每次展示后确认** — 获得用户批准再继续

## 视觉内容判断
使用 show_visual 的场景：
- 选项对比（A/B/C 选择）
- 布局/原型（线框图、界面草图）
- 架构图、流程图、数据关系

直接文字回复的场景：
- 澄清问题
- 需求确认
- 权衡分析

## 工具限制
仅可使用只读工具和 show_visual / read_visual_choice。
禁止写文件、执行命令、修改代码。
```

### 5.2 `index.ts` — 加载 brainstorm.md

在 fable-behavior 的模式 slice 加载逻辑中，为 `brainstorm` 模式加载 `brainstorm.md`，与 `ask.md`、`debug.md`、`plan.md` 并列。

---

## 6. 前端层改动（`tauri-agent/`）

### 6.1 `stores/modeStore.ts`

```typescript
export type AgentMode = 'agent' | 'ask' | 'debug' | 'plan' | 'brainstorm';

export const AGENT_MODES: AgentMode[] = ['agent', 'ask', 'debug', 'plan', 'brainstorm'];

export const MODE_LABELS: Record<AgentMode, string> = {
  agent: 'Agent',
  ask: 'Ask',
  debug: 'Debug',
  plan: 'Plan',
  brainstorm: 'Brainstorm',
};

export function isAgentMode(v: unknown): v is AgentMode {
  return v === 'agent' || v === 'ask' || v === 'debug' || v === 'plan' || v === 'brainstorm';
}
```

### 6.2 `features/chat/input/actions/ModeAction.tsx`

新增图标映射：

```typescript
import { Bot, Brain, Bug, ListChecks, MessageCircleQuestion, type LucideIcon } from 'lucide-react';

const MODE_ICONS: Record<AgentMode, LucideIcon> = {
  agent: Bot,
  ask: MessageCircleQuestion,
  debug: Bug,
  plan: ListChecks,
  brainstorm: Brain,  // Brain 图标
};
```

`options` 数组自动包含新模式（由 `AGENT_MODES` 生成），无需额外修改。

### 6.3 视觉伴侣（已有，零改动）

`VisualCard`、`VisualPanel`、`visualStore`、`ExtensionUiHost` 中的 `visual` 分发 — 全部已实现并可用，brainstorm 模式直接复用。

---

## 7. 完整调用序列

```
用户点击 Brainstorm 按钮
  ↓
ModeAction.onChange('brainstorm')
  → useModeStore.setMode(ws, 'brainstorm')  [乐观更新]
  → pi.setMode(ws, 'brainstorm')
  ↓
sidecar applyMode('brainstorm')
  → savedTools = pi.getActiveTools()
  → pi.setActiveTools(BRAINSTORM_TOOLS ∩ allTools)
  → ctx.ui.setStatus('agent-mode', 'brainstorm')
  → persistState()
  ↓
前端 ExtensionUiHost → useModeStore.setMode(ws, 'brainstorm')
ModeAction 高亮显示「Brainstorm」

AI 响应（受 brainstorm.md system prompt 引导）
  ↓ [当需要展示视觉选项时]
AI 调用 show_visual(html, 'auto')
  → setStatus('visual', {action:'show', html, mode})
  → sendMessage({customType:'visual-inline', content:html})
  ↓
VisualCard 内联渲染（简单选项）
或 VisualPanel 右侧面板（复杂原型）
  ↓
AI 调用 read_visual_choice()
  → ctx.ui.input(sentinel) 阻塞
  ↓
用户点击选项 → extensionUiRespond({type:'extension_ui_response', id, value})
  → read_visual_choice 返回 {choice, text, timestamp}
  ↓
AI 继续头脑风暴流程
```

---

## 8. 错误处理

| 场景 | 处理 |
|------|------|
| brainstorm 模式下调用写类工具 | `gateToolCall` 拦截，提示「头脑风暴模式：已禁用工具 X，请切回 Agent 模式再实施」 |
| `read_visual_choice` 超时（默认 300s）| 工具返回 `{error:"timeout"}`，AI 可询问用户是否继续 |
| 切离 brainstorm 模式 | `applyMode` 还原 `savedTools`，清除模式专属状态 |
| `show_visual` 在非 brainstorm 模式调用 | 正常工作（工具不依赖模式）|

---

## 9. 范围外

- 会话历史区分 brainstorm / 普通对话
- 头脑风暴进度（步骤 N/M）的持久化与恢复
- Brainstorm 专属侧栏面板（会话导航仍用通用侧栏）
- 自动检测 brainstorming skill 调用并切换模式（手动切换已足够）

---

## 10. 实现顺序

1. `extensions/agent-mode/modes.ts` — 添加 brainstorm 类型和工具集
2. `extensions/agent-mode/index.ts` — switchMode/applyMode/gateToolCall 适配
3. `extensions/fable-behavior/prompts/modes/brainstorm.md` — 编写 system prompt
4. `extensions/fable-behavior/index.ts` — 加载 brainstorm.md
5. `tauri-agent/src/stores/modeStore.ts` — 添加 brainstorm 类型
6. `tauri-agent/src/features/chat/input/actions/ModeAction.tsx` — Brain 图标
7. 重编译 sidecar：`bun run build:sidecar`
8. 端到端测试：切换模式 → AI 头脑风暴 → show_visual → 用户点击 → AI 继续
