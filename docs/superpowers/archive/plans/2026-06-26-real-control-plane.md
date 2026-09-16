# SP-4 真控制面（去伪对话）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 模式/审批切换与配置重载走真正的控制面（config 侧信道 + 既有热重载），不再伪装成 prompt 塞进对话流。

**架构：** 桌面把期望的 mode/approval 写进 `PI_RUNTIME_CONFIG`；`agent-mode`/`approval` 扩展用 `watchConfig` 即时 apply（apply 多在 `pi.*` 上、无需 ctx）；provider 配置重读用"写 config + bump PI_RELOAD_REV → 既有 session.reload()"替换 switch-session-to-self。

**技术栈：** TypeScript 扩展（`watchConfig`）、Rust（Tauri 写 config）、既有 `runtime-config.ts` + `main.ts` 热重载、vitest。

设计来源：`docs/superpowers/specs/2026-06-26-real-control-plane-design.md`。

---

## 文件结构

- 创建：`extensions/_shared/control-config.ts` —— `readControl()`（纯：从 getConfig 读 MODE/APPROVAL）。
- 创建：`extensions/_shared/control-config.test.ts`。
- 修改：`extensions/agent-mode/index.ts` —— 加 `watchConfig` 即时 apply 模式。
- 修改：`extensions/approval/index.ts` —— 加 `watchConfig` 即时 apply 审批。
- 修改：`tauri-agent/src-tauri/src/commands/agent.rs` —— `agent_set_mode`/`agent_set_approval` 改为写 config（去假 prompt）。
- 修改：`tauri-agent/src-tauri/src/commands/providers.rs` —— 加 `reload_config`（写 config + bump rev）替换 `broadcast_refresh` 的 switch-session。

---

## 任务 1：`readControl` 纯逻辑

**文件：**
- 创建：`extensions/_shared/control-config.ts`
- 测试：`extensions/_shared/control-config.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// extensions/_shared/control-config.test.ts
import { describe, expect, it } from "vitest";
import { readControl } from "./control-config.js";

const cfg = (m: Record<string, string>) => (k: string) => m[k];

describe("readControl", () => {
  it("reads valid mode + approval", () => {
    expect(readControl(cfg({ CONTROL_MODE: "plan", CONTROL_APPROVAL: "auto" }))).toEqual({
      mode: "plan",
      approval: "auto",
    });
  });
  it("ignores invalid values", () => {
    expect(readControl(cfg({ CONTROL_MODE: "bogus", CONTROL_APPROVAL: "x" }))).toEqual({});
  });
  it("returns {} when unset", () => {
    expect(readControl(cfg({}))).toEqual({});
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd extensions && npx vitest run _shared/control-config.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：编写实现**

```ts
// extensions/_shared/control-config.ts
// 控制面侧信道：从 runtime-config 读期望的 mode/approval（桌面写、扩展读），不经对话流。
const MODES = new Set(["agent", "ask", "debug", "plan"]);
const APPROVALS = new Set(["ask", "auto", "full"]);

export interface ControlState {
  mode?: "agent" | "ask" | "debug" | "plan";
  approval?: "ask" | "auto" | "full";
}

export function readControl(get: (key: string) => string | undefined): ControlState {
  const out: ControlState = {};
  const m = get("CONTROL_MODE");
  if (m && MODES.has(m)) out.mode = m as ControlState["mode"];
  const a = get("CONTROL_APPROVAL");
  if (a && APPROVALS.has(a)) out.approval = a as ControlState["approval"];
  return out;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd extensions && npx vitest run _shared/control-config.test.ts`
预期：PASS（3 passed）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/_shared/control-config.ts extensions/_shared/control-config.test.ts
git commit -m "feat(sp4): control-config side-channel reader"
```

## 任务 2：agent-mode 即时 apply（去假 prompt 入口）

**文件：**
- 修改：`extensions/agent-mode/index.ts`

- [ ] **步骤 1：watchConfig 驱动 applyMode**

在 `agent-mode` 工厂内（`switchMode`/`applyMode` 已存在，:85/:105），加：

```ts
import { watchConfig } from "../_shared/runtime-config.js";
import { readControl } from "../_shared/control-config.js";

// 控制面：桌面写 CONTROL_MODE → 即时切模式（工具集走 pi.setActiveTools，无需 ctx；
// 状态回推 ctx.ui.setStatus 延迟到下一个生命周期事件）。
let pendingPush = false;
watchConfig((next) => {
  const desired = readControl((k) => next[k]).mode;
  if (desired && desired !== currentMode) {
    // applyMode 需要 ctx 做 pushStatus；这里用 pi.* 完成工具集切换，状态推迟。
    const wasRestricted = toolWhitelist(currentMode) !== undefined;
    const willRestrict = toolWhitelist(desired) !== undefined;
    if (willRestrict && !wasRestricted) savedTools = pi.getActiveTools();
    currentMode = desired;
    if (willRestrict) pi.setActiveTools(activeToolsFor(desired, savedTools ?? pi.getActiveTools()) ?? []);
    else if (wasRestricted && savedTools) pi.setActiveTools(savedTools);
    persistState();
    pendingPush = true;
  }
});
```

并在已有的 `turn_start`/`agent_end`（或新增 `turn_start`）handler 里：`if (pendingPush) { pushStatus(ctx); pendingPush = false; }`。

- [ ] **步骤 2：typecheck**

运行：`cd cli && npm run typecheck`
预期：通过。

- [ ] **步骤 3：Commit**

```bash
git add extensions/agent-mode/index.ts
git commit -m "feat(sp4): agent-mode applies mode from control side-channel"
```

## 任务 3：approval 即时 apply

**文件：**
- 修改：`extensions/approval/index.ts`

- [ ] **步骤 1：watchConfig 驱动 setApprovalPolicy**

```ts
import { watchConfig } from "../_shared/runtime-config.js";
import { readControl } from "../_shared/control-config.js";

watchConfig((next) => {
  const desired = readControl((k) => next[k]).approval;
  if (desired && desired !== getApprovalPolicy()) {
    setApprovalPolicy(desired);
    persist();
    // 状态推迟到下次 session_start/命令；桌面乐观回显
  }
});
```

- [ ] **步骤 2：typecheck + Commit**

运行：`cd cli && npm run typecheck`

```bash
git add extensions/approval/index.ts
git commit -m "feat(sp4): approval applies policy from control side-channel"
```

## 任务 4：Tauri 改写控制命令（去假 prompt + 替换 switch-session）

**文件：**
- 修改：`tauri-agent/src-tauri/src/commands/agent.rs:359,381`
- 修改：`tauri-agent/src-tauri/src/commands/providers.rs:68`

- [ ] **步骤 1：`agent_set_mode`/`agent_set_approval` 改写 config**

把 `agent_set_mode`（:359）从 `Prompt { "/mode …" }` 改为：写 `CONTROL_MODE=<mode>` 到 `PI_RUNTIME_CONFIG`（复用现有写 runtime config 的 helper——`grep -rn "PI_RUNTIME_CONFIG\|runtime.config\|write_runtime_config" tauri-agent/src-tauri/src` 找到现成写入点，如 SKILLS_DISABLED/PI_RELOAD_REV 的写入函数）。`agent_set_approval`（:381）同理写 `CONTROL_APPROVAL`。bump 一个 rev 触发 watch（runtime-config 的 fs.watch 已监听文件变更，无需额外 rev；写文件即触发）。

- [ ] **步骤 2：`reload_config` 替换 switch-session-to-self**

新增 `reload_config`（`providers.rs`）：写/确保 config + bump `PI_RELOAD_REV`（复用现有 bump helper），依赖 `main.ts:151` 既有 `session.reload()` 完成重读。`set_provider_config`（:131）末尾把 `broadcast_refresh(&mgr)` 调用替换为 `reload_config` 路径；删除 `broadcast_refresh`（:68）的 switch-session 实现。

- [ ] **步骤 3：编译 + 测试**

运行：`cd tauri-agent/src-tauri && cargo build && cargo test`
预期：通过；providers.rs 既有单测（atomic_write 等）仍 PASS。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/agent.rs tauri-agent/src-tauri/src/commands/providers.rs
git commit -m "refactor(sp4): control ops via config side-channel, drop fake-prompt + switch-session reload"
```

---

## 自检

- 规格覆盖：config 读取（任务1）✓、mode 即时 apply（任务2）✓、approval 即时 apply（任务3）✓、去假 prompt（任务4步1）✓、reload_config 替换 switch-session（任务4步2）✓、回退默认（readControl 忽略非法值）✓。
- 占位符：无；runtime-config 写入/bump helper 标注"以现有代码为准"并给确认命令。
- 类型一致：`ControlState.mode`/`approval` 取值集与 agent-mode 的 `AgentMode`、approval 的 `ApprovalPolicy` 对齐（agent/ask/debug/plan；ask/auto/full）。
- 回归断言（建议加）：切模式后会话历史不出现 `/mode` 伪用户消息。
