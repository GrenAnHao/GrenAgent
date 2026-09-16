# Brainstorm 模式实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在现有 agent-mode 体系中新增 `brainstorm` 模式，让 AI 在头脑风暴流程中通过已有 VisualCard/VisualPanel 直接在 GrenAgent 内呈现可交互视觉内容，无需外部浏览器。

**架构：** 在 `extensions/agent-mode/modes.ts` 添加 brainstorm 模式类型和工具白名单，在 `extensions/fable-behavior/loader.ts` 扩展 `FableAgentMode` 类型并新增 `brainstorm.md` prompt，在 `tauri-agent` 前端的 `modeStore.ts` 和 `ModeAction.tsx` 添加对应的类型和图标，最后重编译 sidecar。

**技术栈：** TypeScript (extensions/tauri-agent)、Vitest (tests)、Bun (sidecar 编译)

---

## 文件清单

| 文件 | 变更类型 | 职责 |
|------|---------|------|
| `extensions/agent-mode/modes.ts` | 修改 | 添加 brainstorm 类型、BRAINSTORM_TOOLS、toolWhitelist/gateToolCall/modeBadge/modeLabel 适配 |
| `extensions/agent-mode/modes.test.ts` | 修改 | 新增 brainstorm 相关测试 |
| `extensions/fable-behavior/loader.ts` | 修改 | `FableAgentMode` 添加 brainstorm、`resolveAgentModeFromEntries` 识别 brainstorm |
| `extensions/fable-behavior/loader.test.ts` | 修改 | 新增 brainstorm 模式解析测试 |
| `extensions/fable-behavior/prompts/modes/brainstorm.md` | 创建 | brainstorm system prompt |
| `tauri-agent/src/stores/modeStore.ts` | 修改 | `AgentMode` 类型、`AGENT_MODES`、`MODE_LABELS`、`isAgentMode` 添加 brainstorm |
| `tauri-agent/src/features/chat/input/actions/ModeAction.tsx` | 修改 | Brain 图标映射 |

---

## 任务 1：modes.ts — 添加 brainstorm 模式

**文件：**
- 修改：`extensions/agent-mode/modes.ts`
- 测试：`extensions/agent-mode/modes.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `extensions/agent-mode/modes.test.ts` 末尾追加：

```typescript
describe("brainstorm mode", () => {
  it("isAgentMode recognizes brainstorm", () => {
    expect(isAgentMode("brainstorm")).toBe(true);
  });

  it("parseModeArg parses brainstorm", () => {
    expect(parseModeArg("brainstorm")).toBe("brainstorm");
    expect(parseModeArg("BRAINSTORM")).toBe("brainstorm");
  });

  it("toolWhitelist restricts brainstorm", () => {
    expect(toolWhitelist("brainstorm")).toBeDefined();
  });

  it("brainstorm includes show_visual and read_visual_choice", () => {
    const wl = toolWhitelist("brainstorm")!;
    expect(wl).toContain("show_visual");
    expect(wl).toContain("read_visual_choice");
  });

  it("brainstorm includes ask tools (read/grep)", () => {
    const wl = toolWhitelist("brainstorm")!;
    expect(wl).toContain("read");
    expect(wl).toContain("grep");
  });

  it("brainstorm excludes write/edit/bash", () => {
    const all = ["read", "grep", "write", "edit", "bash", "show_visual", "read_visual_choice"];
    const active = activeToolsFor("brainstorm", all)!;
    expect(active).not.toContain("write");
    expect(active).not.toContain("edit");
    expect(active).not.toContain("bash");
    expect(active).toContain("show_visual");
  });

  it("gateToolCall blocks write in brainstorm", () => {
    const result = gateToolCall("brainstorm", "write", {});
    expect(result?.block).toBe(true);
  });

  it("gateToolCall allows show_visual in brainstorm", () => {
    const result = gateToolCall("brainstorm", "show_visual", {});
    expect(result).toBeUndefined();
  });

  it("modeBadge returns Brainstorm", () => {
    expect(modeBadge("brainstorm")).toBe("Brainstorm");
  });

  it("modeLabel returns 头脑风暴", () => {
    expect(modeLabel("brainstorm")).toBe("头脑风暴");
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

```bash
cd extensions && npx vitest run agent-mode/modes.test.ts 2>&1 | Select-Object -Last 10
```
预期：FAIL，报错 `brainstorm` 相关类型不存在

- [ ] **步骤 3：修改 `modes.ts`**

完整替换 `extensions/agent-mode/modes.ts`：

```typescript
// 模式定义与纯逻辑：工具白名单、工具调用 gate、命令参数解析、徽章/标签。
// 无 I/O，便于单测。状态机与副作用（setActiveTools/setStatus/persist）在 index.ts。
import { isSafeCommand } from "./utils.js";

export type AgentMode = "agent" | "ask" | "debug" | "plan" | "brainstorm";

export const AGENT_MODES: readonly AgentMode[] = ["agent", "ask", "debug", "plan", "brainstorm"] as const;

export const DEFAULT_MODE: AgentMode = "agent";

export function isAgentMode(v: unknown): v is AgentMode {
  return typeof v === "string" && (AGENT_MODES as readonly string[]).includes(v);
}

// ask：纯只读问答。白名单为经核实存在的只读工具（工具名取自各扩展的 registerTool）：
//   - pi 内置：read / grep / find / ls
//   - 联网只读：fetch_url / fetch_llms / fetch_html / fetch_markdown / fetch_txt / fetch_json（web-fetch）、
//     web_search / web_search_multi / fetch_web_content / fetch_github_readme（web-search）
//   - 本地只读检索：search（batch-tools 多正则/glob 本地检索）、code_search（code-search）、kb_search（knowledge-rag）、
//     memory_recall（long-term-memory）、history_search（session-search）、git_diff（code-review）
//   - 交互/只读视图（不改文件）：ask_user（agent-mode 提问卡）、hl_read（hashline 带 #TAG 的只读视图）
// 写类(write/edit/kb_add/memory_save/review_note/todo/generate_image/speak)、命令行(bash)、
// 子代理(spawn_agent/explore_context)、外部命令(diagnostics)、MCP(<server>__*) 一律不在白名单，
// 经 setActiveTools 隐藏 + tool_call 兜底双重拦截。多列的名字若当前不可用，会在 activeToolsFor 交集中被滤除。
export const ASK_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "fetch_url",
  "fetch_llms",
  "fetch_html",
  "fetch_markdown",
  "fetch_txt",
  "fetch_json",
  "web_search",
  "web_search_multi",
  "fetch_web_content",
  "fetch_github_readme",
  "search",
  "code_search",
  "kb_search",
  "memory_recall",
  "history_search",
  "git_diff",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_diagnostics",
  "lsp_document_symbols",
  "hl_read",
  "ask_user",
];

// plan：在 ask 的只读集之上额外放行 bash（再由 isSafeCommand 限定为只读命令），与既有规划模式一致。
export const PLAN_TOOLS: readonly string[] = [...ASK_TOOLS, "bash"];

// brainstorm：在 ask 的只读集之上额外放行 visual-companion 工具，用于头脑风暴时展示原型和选项。
export const BRAINSTORM_TOOLS: readonly string[] = [
  ...ASK_TOOLS,
  "show_visual",
  "read_visual_choice",
];

// 受限模式返回白名单；agent/debug 用完整工具集（返回 undefined 表示不限制）。
export function toolWhitelist(mode: AgentMode): readonly string[] | undefined {
  if (mode === "ask") return ASK_TOOLS;
  if (mode === "plan") return PLAN_TOOLS;
  if (mode === "brainstorm") return BRAINSTORM_TOOLS;
  return undefined;
}

// 取白名单与当前全量工具的交集，避免 setActiveTools 激活不存在的工具名。
// 交集为空（极端情况）时回退到白名单本身，保证绝不放开写类工具。
export function activeToolsFor(mode: AgentMode, allTools: readonly string[]): string[] | undefined {
  const wl = toolWhitelist(mode);
  if (!wl) return undefined;
  const set = new Set(allTools);
  const picked = wl.filter((t) => set.has(t));
  return picked.length > 0 ? picked : [...wl];
}

export interface ToolGateResult {
  block: boolean;
  reason: string;
}

// tool_call 兜底拦截（setActiveTools 之外的第二道防线，防止动态注册的工具绕过白名单）：
//   ask       : 白名单之外一律拦（含 bash/write/edit/MCP/写类扩展工具）
//   plan      : 白名单（只读检索 + 只读 bash）之外一律拦
//   brainstorm: 白名单（只读检索 + show_visual/read_visual_choice）之外一律拦
//   agent/debug : 不拦（debug 的危险命令仍由 safety 扩展把关）
export function gateToolCall(mode: AgentMode, toolName: string, input: unknown): ToolGateResult | undefined {
  if (mode === "ask") {
    if (ASK_TOOLS.includes(toolName)) return undefined;
    return {
      block: true,
      reason:
        `问答模式（只读）：已禁用工具「${toolName}」。本模式仅允许只读检索与联网查阅，` +
        `不能修改文件、执行命令行或调用 MCP。如需动手改动，请切换到 Agent 或 Debug 模式。`,
    };
  }
  if (mode === "plan") {
    if (toolName === "write" || toolName === "edit") {
      return { block: true, reason: "规划模式：禁止写入/编辑。请先切到 Agent 模式再执行计划。" };
    }
    if (toolName === "bash") {
      const command = String((input as { command?: unknown } | null)?.command ?? "");
      if (!isSafeCommand(command)) {
        return { block: true, reason: `规划模式：命令未在只读白名单内，已阻止。\n命令：${command}` };
      }
      return undefined;
    }
    if (!PLAN_TOOLS.includes(toolName)) {
      return {
        block: true,
        reason:
          `规划模式（只读）：已禁用工具「${toolName}」。本模式仅允许只读检索与白名单内只读命令，` +
          `不能写文件 / 执行代码 / 调试。如需动手，请切换到 Agent 模式。`,
      };
    }
    return undefined;
  }
  if (mode === "brainstorm") {
    if (BRAINSTORM_TOOLS.includes(toolName)) return undefined;
    return {
      block: true,
      reason:
        `头脑风暴模式（只读）：已禁用工具「${toolName}」。本模式仅允许只读检索与视觉伴侣工具，` +
        `不能修改文件或执行命令。如需动手实施，请切换到 Agent 模式。`,
    };
  }
  return undefined;
}

// 解析 /mode 命令参数为目标模式；空或非法返回 undefined（调用方据此提示用法）。
export function parseModeArg(args: string): AgentMode | undefined {
  const a = args.trim().toLowerCase();
  return isAgentMode(a) ? a : undefined;
}

// 状态栏徽章文本；agent（默认）不显示徽章。
export function modeBadge(mode: AgentMode): string | undefined {
  switch (mode) {
    case "ask":
      return "Ask";
    case "debug":
      return "Debug";
    case "plan":
      return "Plan";
    case "brainstorm":
      return "Brainstorm";
    default:
      return undefined;
  }
}

// 模式中文名（通知文案用）。
export function modeLabel(mode: AgentMode): string {
  switch (mode) {
    case "ask":
      return "问答（只读）";
    case "debug":
      return "调试";
    case "plan":
      return "规划";
    case "brainstorm":
      return "头脑风暴";
    default:
      return "Agent";
  }
}
```

- [ ] **步骤 4：运行测试确认通过**

```bash
cd extensions && npx vitest run agent-mode/modes.test.ts 2>&1 | Select-Object -Last 10
```
预期：PASS，含新增的 brainstorm 测试全部通过

- [ ] **步骤 5：Commit**

```bash
git add extensions/agent-mode/modes.ts extensions/agent-mode/modes.test.ts
git commit -m "feat(brainstorm): add brainstorm mode type and tool whitelist"
```

---

## 任务 2：fable-behavior — FableAgentMode + brainstorm.md

**文件：**
- 修改：`extensions/fable-behavior/loader.ts`
- 修改：`extensions/fable-behavior/loader.test.ts`
- 创建：`extensions/fable-behavior/prompts/modes/brainstorm.md`

- [ ] **步骤 1：编写失败的测试**

在 `extensions/fable-behavior/loader.test.ts` 找到 `resolveAgentModeFromEntries` 相关测试（如无则在文件末尾添加）：

```typescript
describe("resolveAgentModeFromEntries — brainstorm", () => {
  it("returns brainstorm when last agent-mode entry has mode=brainstorm", () => {
    const entries = [
      { type: "custom", customType: "agent-mode", data: { mode: "brainstorm" } },
    ];
    expect(resolveAgentModeFromEntries(entries)).toBe("brainstorm");
  });

  it("falls back to agent for unknown mode", () => {
    const entries = [
      { type: "custom", customType: "agent-mode", data: { mode: "unknown" } },
    ];
    expect(resolveAgentModeFromEntries(entries)).toBe("agent");
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

```bash
cd extensions && npx vitest run fable-behavior/loader.test.ts 2>&1 | Select-Object -Last 10
```
预期：brainstorm 测试 FAIL（`resolveAgentModeFromEntries` 不识别 brainstorm）

- [ ] **步骤 3：修改 `loader.ts`**

在 `extensions/fable-behavior/loader.ts` 做以下两处改动：

**第 5 行** — 修改 `FableAgentMode`：
```typescript
export type FableAgentMode = "agent" | "ask" | "debug" | "plan" | "brainstorm";
```

**第 126 行** — 修改 `resolveAgentModeFromEntries` 的识别逻辑：
```typescript
export function resolveAgentModeFromEntries(
  entries: Array<{ type?: string; customType?: string; data?: unknown }>,
): FableAgentMode {
  const entry = entries.filter((e) => e.type === "custom" && e.customType === "agent-mode").pop();
  const mode = (entry?.data as { mode?: string } | undefined)?.mode;
  if (mode === "ask" || mode === "debug" || mode === "plan" || mode === "agent" || mode === "brainstorm") return mode;
  return "agent";
}
```

- [ ] **步骤 4：创建 `brainstorm.md`**

创建文件 `extensions/fable-behavior/prompts/modes/brainstorm.md`：

```markdown
# Brainstorm Mode

You are in brainstorm mode. Your role is to help the user explore ideas and reach a design, not to implement.

## Core principles
- **One question at a time** — never ask multiple questions in one message
- **Visual-first** — when content is visual (prototypes, layouts, architecture diagrams, A/B/C option comparisons), use `show_visual` + `read_visual_choice`; reply in text for conceptual/requirements questions
- **No implementation** — do not write code, modify files, or run commands; only explore ideas, propose options, and show prototypes
- **Incremental approval** — show a design section, get approval, then continue

## When to use show_visual vs text

Use `show_visual` for:
- A/B/C option comparisons (use `.options` / `.option` / `.letter` / `data-choice` structure)
- Layout wireframes and UI prototypes
- Architecture diagrams, flowcharts, entity relationships

Reply in text for:
- Clarifying questions
- Requirements confirmation
- Tradeoffs analysis (pros/cons lists)

## Visual HTML structure (mandatory)

When using show_visual for options, always use this exact structure so clicks are detected:

```html
<div class="options">
  <div class="option" data-choice="a" onclick="toggleSelect(this)">
    <div class="letter">A</div>
    <div class="content"><h3>Option title</h3><p>Description</p></div>
  </div>
</div>
```

Key rules:
- `data-choice` attribute is **required** (not `data-value`)
- `onclick="toggleSelect(this)"` is required for visual feedback
- Use `data-choice` values: `a`, `b`, `c`, `d` etc.

## Tool restrictions
Only read-only tools and `show_visual` / `read_visual_choice` are available.
Writing files, running commands, and code execution are disabled in this mode.
```

- [ ] **步骤 5：运行测试确认通过**

```bash
cd extensions && npx vitest run fable-behavior/loader.test.ts 2>&1 | Select-Object -Last 10
```
预期：PASS

- [ ] **步骤 6：Commit**

```bash
git add extensions/fable-behavior/loader.ts extensions/fable-behavior/loader.test.ts extensions/fable-behavior/prompts/modes/brainstorm.md
git commit -m "feat(brainstorm): add brainstorm FableAgentMode + system prompt"
```

---

## 任务 3：前端 modeStore — 添加 brainstorm 类型

**文件：**
- 修改：`tauri-agent/src/stores/modeStore.ts`

（前端无单元测试框架测试此 store 的类型——类型正确性由 `tsc --noEmit` 验证）

- [ ] **步骤 1：修改 `modeStore.ts`**

完整替换 `tauri-agent/src/stores/modeStore.ts`：

```typescript
import { create } from 'zustand';

export type AgentMode = 'agent' | 'ask' | 'debug' | 'plan' | 'brainstorm';

export const AGENT_MODES: AgentMode[] = ['agent', 'ask', 'debug', 'plan', 'brainstorm'];

/** 模式显示名（选择器选项用）。 */
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

interface ModeState {
  /** 各 workspace 的当前模式（由 sidecar agent-mode 扩展经 setStatus 推送回读）。 */
  byWorkspace: Record<string, AgentMode>;
  setMode: (workspace: string, mode: AgentMode) => void;
}

export const useModeStore = create<ModeState>((set) => ({
  byWorkspace: {},
  setMode: (workspace, mode) =>
    set((s) =>
      s.byWorkspace[workspace] === mode
        ? s
        : { byWorkspace: { ...s.byWorkspace, [workspace]: mode } },
    ),
}));
```

- [ ] **步骤 2：TypeScript 检查**

```bash
cd tauri-agent && npx tsc --noEmit 2>&1 | Select-Object -First 15
```
预期：无新增类型错误

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/stores/modeStore.ts
git commit -m "feat(brainstorm): add brainstorm to frontend modeStore"
```

---

## 任务 4：前端 ModeAction — Brain 图标

**文件：**
- 修改：`tauri-agent/src/features/chat/input/actions/ModeAction.tsx`

- [ ] **步骤 1：修改 `ModeAction.tsx`**

完整替换 `tauri-agent/src/features/chat/input/actions/ModeAction.tsx`：

```typescript
import { Icon } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { Bot, Brain, Bug, ListChecks, MessageCircleQuestion, type LucideIcon } from 'lucide-react';
import { useAgentStoreContext } from '../../../../stores/AgentStoreContext';
import { pi } from '../../../../lib/pi';
import { AGENT_MODES, MODE_LABELS, useModeStore, type AgentMode } from '../../../../stores/modeStore';

/** 每个模式的 lucide 图标（统一经 @lobehub/ui 的 Icon 渲染，不用 emoji）。 */
const MODE_ICONS: Record<AgentMode, LucideIcon> = {
  agent: Bot,
  ask: MessageCircleQuestion,
  debug: Bug,
  plan: ListChecks,
  brainstorm: Brain,
};

/**
 * 模式选择器：Agent / Ask / Debug / Plan / Brainstorm 互斥单选，每项带图标。
 * 当前模式由 sidecar 的 agent-mode 扩展经 setStatus 推送到 modeStore（切会话/刷新后回读）；
 * 切换走 agent_set_mode（底层 /mode 命令，不调 LLM），并乐观更新本地状态即时反馈。
 */
export default function ModeAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const mode = useModeStore((s) => s.byWorkspace[workspace] ?? 'agent');

  const onChange = (next: string) => {
    const target = next as AgentMode;
    // 乐观更新，避免等待后端 setStatus 回推的延迟；后端确认后会再推一次（值一致，无抖动）。
    useModeStore.getState().setMode(workspace, target);
    void pi.setMode(workspace, target);
  };

  // 下拉项用 optionRender 带图标；trigger 的当前图标用 prefix——两者分离，避免触发器上图标重复。
  const options = AGENT_MODES.map((m) => ({ label: MODE_LABELS[m], value: m }));

  return (
    <Select
      size="small"
      popupMatchSelectWidth={false}
      disabled={!workspaceReady}
      value={mode}
      options={options}
      optionRender={(option) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon icon={MODE_ICONS[option.value as AgentMode]} size={14} />
          {MODE_LABELS[option.value as AgentMode]}
        </span>
      )}
      placeholder="模式"
      prefix={MODE_ICONS[mode]}
      style={{ width: 'auto', maxWidth: 120 }}
      onChange={onChange}
    />
  );
}
```

- [ ] **步骤 2：TypeScript 检查**

```bash
cd tauri-agent && npx tsc --noEmit 2>&1 | Select-Object -First 15
```
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add tauri-agent/src/features/chat/input/actions/ModeAction.tsx
git commit -m "feat(brainstorm): add Brain icon to ModeAction"
```

---

## 任务 5：重编译 sidecar + 端到端测试

**文件：** 无代码修改，仅编译与验证

- [ ] **步骤 1：重编译 sidecar**

```bash
cd tauri-agent && bun run build:sidecar 2>&1 | Select-Object -Last 5
```
预期末行：`GrenAgent sidecar ready: ...binaries/pi-x86_64-pc-windows-msvc.exe`

- [ ] **步骤 2：启动 GrenAgent**

```bash
cd tauri-agent && bun run tauri dev
```

- [ ] **步骤 3：验证模式切换器显示 Brainstorm**

在 GrenAgent 聊天输入框左侧的模式选择器下拉菜单中，确认出现「Brainstorm」选项（带 Brain 图标）。

- [ ] **步骤 4：验证工具限制**

切换到 Brainstorm 模式后，发送消息：
```
请用 write 工具写一个测试文件
```
预期：AI 回复被拦截，显示「头脑风暴模式（只读）：已禁用工具「write」」

- [ ] **步骤 5：验证视觉伴侣工作**

切换到 Brainstorm 模式后，发送消息：
```
请帮我头脑风暴一个功能，用 show_visual 展示 3 个选项（用 .options/.option/.letter 结构和 data-choice 属性），然后用 read_visual_choice 等我选择。
```
预期：
- 聊天流中出现 VisualCard（内联 iframe）
- 可以点击选项（视觉反馈：选中高亮）
- AI 收到选择结果后继续响应

- [ ] **步骤 6：Commit**

如果端到端有 bugfix：
```bash
git add -A && git commit -m "fix(brainstorm): e2e fixes"
```

---

## 规格覆盖检查

| 规格章节 | 对应任务 |
|---------|---------|
| `modes.ts` — brainstorm 类型 + BRAINSTORM_TOOLS | 任务 1 |
| `gateToolCall` brainstorm 分支 | 任务 1 |
| `modeBadge` / `modeLabel` brainstorm | 任务 1 |
| `loader.ts` — FableAgentMode 添加 brainstorm | 任务 2 |
| `resolveAgentModeFromEntries` 识别 brainstorm | 任务 2 |
| `brainstorm.md` system prompt | 任务 2 |
| `modeStore.ts` 前端类型 | 任务 3 |
| `ModeAction.tsx` Brain 图标 | 任务 4 |
| sidecar 重编译 | 任务 5 |
| 端到端验证 | 任务 5 |
