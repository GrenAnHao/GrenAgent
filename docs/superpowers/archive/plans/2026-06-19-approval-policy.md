# 审批策略（Codex 式三级预设）实现计划

> **面向 AI 代理的工作者：** 必需子技能：superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务实现。步骤用复选框（`- [ ]`）。

**目标：** 新增与「模式」并列的「审批策略」三级预设（请求批准 / 替我审批 / 完全访问），每级同时控「沙箱 scope + 确认级别」，打通 safety 与统一沙箱层。

**架构：** 复刻 agent-mode 状态流——`_shared/approval.ts` 进程内共享策略 + `approval` 扩展（命令/持久化/setStatus）+ 前端 `ApprovalAction` 下拉 + Tauri `agent_set_approval`；safety 读策略决定 confirm，沙箱消费者读策略决定是否隔离。

**技术栈：** TS（ESM，`.js` 导入）、vitest、Tauri（Rust）、React + `@lobehub/ui/base-ui`。

**规格：** `docs/superpowers/specs/2026-06-19-approval-policy-design.md`

---

## 文件结构

新增：
- `extensions/_shared/approval.ts`（+ `.test.ts`）— 共享策略单例 + parse/labels。
- `extensions/approval/index.ts`（+ `package.json`）— 命令/持久化/setStatus 扩展。
- `extensions/_shared/sandbox-gate.ts`（+ `.test.ts`）— `sandboxOn()` 统一判据（SANDBOX_ENABLE + 策略 + 可用性）。
- `tauri-agent/src/stores/approvalStore.ts`（+ `.test.ts`）。
- `tauri-agent/src/features/chat/input/actions/ApprovalAction.tsx`。

修改：
- `extensions/index.ts` — 注册 approval 扩展。
- `extensions/safety/index.ts` — 读策略做 full/auto/ask 门控。
- `extensions/code-exec/sandbox-exec.ts`、`extensions/im-platforms/index.ts`、`extensions/multi-agent/index.ts` — 沙箱判据改用 `sandboxOn()`。
- `tauri-agent/src/lib/pi.ts` — `setApproval`。
- `tauri-agent/src/features/extensionUi/ExtensionUiHost.tsx` — 处理 `approval-policy` 状态。
- 输入框工具条组件 — 挂 `<ApprovalAction/>`（ModeAction 旁，实现时定位）。
- `tauri-agent/src-tauri/src/commands/agent.rs` + `lib.rs` — `agent_set_approval`。

---

## Phase 1：共享策略 + 扩展

### 任务 1：`_shared/approval.ts` + 测试

- [ ] **步骤 1：写失败测试** `extensions/_shared/approval.test.ts`
```ts
import { describe, expect, it, beforeEach } from "vitest";
import { getApprovalPolicy, setApprovalPolicy, parseApproval, APPROVAL_LABELS } from "./approval.js";

beforeEach(() => setApprovalPolicy("auto"));

describe("approval policy", () => {
  it("defaults to auto", () => {
    expect(getApprovalPolicy()).toBe("auto");
  });
  it("set/get round-trip", () => {
    setApprovalPolicy("ask");
    expect(getApprovalPolicy()).toBe("ask");
  });
  it("parse accepts known values, rejects others", () => {
    expect(parseApproval("full")).toBe("full");
    expect(parseApproval("ASK")).toBe("ask");
    expect(parseApproval("xx")).toBeUndefined();
    expect(parseApproval(undefined)).toBeUndefined();
  });
  it("has zh labels for all 3", () => {
    expect(Object.keys(APPROVAL_LABELS).sort()).toEqual(["ask", "auto", "full"]);
  });
});
```

- [ ] **步骤 2：运行确认失败** — `npx vitest run _shared/approval`（工作目录 extensions）→ FAIL。

- [ ] **步骤 3：实现** `extensions/_shared/approval.ts`
```ts
// 进程内共享的审批策略（多扩展读同一份）。approval 扩展按 session 设置；
// safety / 沙箱消费者读取。默认 auto（替我审批）。
export type ApprovalPolicy = "ask" | "auto" | "full";

let current: ApprovalPolicy = "auto";

export function getApprovalPolicy(): ApprovalPolicy {
  return current;
}
export function setApprovalPolicy(p: ApprovalPolicy): void {
  current = p;
}
export function parseApproval(s: string | undefined): ApprovalPolicy | undefined {
  const v = (s ?? "").trim().toLowerCase();
  return v === "ask" || v === "auto" || v === "full" ? v : undefined;
}
export const APPROVAL_LABELS: Record<ApprovalPolicy, string> = {
  ask: "请求批准",
  auto: "替我审批",
  full: "完全访问",
};
```

- [ ] **步骤 4：运行确认通过** — PASS。
- [ ] **步骤 5：Commit**
```powershell
git add extensions/_shared/approval.ts extensions/_shared/approval.test.ts
git commit -m "feat(approval): 共享审批策略单例 + parse/labels（任务 1）"
```

### 任务 2：`sandbox-gate.ts` 统一沙箱判据 + 测试

- [ ] **步骤 1：写失败测试** `extensions/_shared/sandbox-gate.test.ts`
```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./runtime-config.js", () => ({ getConfig: vi.fn() }));
vi.mock("./approval.js", () => ({ getApprovalPolicy: vi.fn() }));
vi.mock("./sandbox/index.js", () => ({ getSandbox: vi.fn() }));

import { getConfig } from "./runtime-config.js";
import { getApprovalPolicy } from "./approval.js";
import { getSandbox } from "./sandbox/index.js";
import { sandboxOn } from "./sandbox-gate.js";

const avail = (v: boolean) => ({ isAvailable: async () => v });
beforeEach(() => vi.resetAllMocks());

describe("sandboxOn", () => {
  it("false when SANDBOX_ENABLE=off (master kill)", async () => {
    (getConfig as any).mockReturnValue("off");
    (getApprovalPolicy as any).mockReturnValue("auto");
    (getSandbox as any).mockReturnValue(avail(true));
    expect(await sandboxOn()).toBe(false);
  });
  it("false when policy=full", async () => {
    (getConfig as any).mockReturnValue(undefined);
    (getApprovalPolicy as any).mockReturnValue("full");
    (getSandbox as any).mockReturnValue(avail(true));
    expect(await sandboxOn()).toBe(false);
  });
  it("true when not-off, policy!=full, and available", async () => {
    (getConfig as any).mockReturnValue(undefined);
    (getApprovalPolicy as any).mockReturnValue("auto");
    (getSandbox as any).mockReturnValue(avail(true));
    expect(await sandboxOn()).toBe(true);
  });
  it("false when sandbox unavailable", async () => {
    (getConfig as any).mockReturnValue(undefined);
    (getApprovalPolicy as any).mockReturnValue("ask");
    (getSandbox as any).mockReturnValue(avail(false));
    expect(await sandboxOn()).toBe(false);
  });
});
```

- [ ] **步骤 2：运行确认失败** → FAIL。
- [ ] **步骤 3：实现** `extensions/_shared/sandbox-gate.ts`
```ts
import { getApprovalPolicy } from "./approval.js";
import { getConfig } from "./runtime-config.js";
import { getSandbox } from "./sandbox/index.js";

// 统一沙箱判据：SANDBOX_ENABLE=off 总 kill；策略 full 不隔离；其余在沙箱可用时隔离。
export async function sandboxOn(): Promise<boolean> {
  if (getConfig("SANDBOX_ENABLE") === "off") return false;
  if (getApprovalPolicy() === "full") return false;
  return (await getSandbox()).isAvailable();
}
```

- [ ] **步骤 4：运行确认通过** → PASS。
- [ ] **步骤 5：Commit**
```powershell
git add extensions/_shared/sandbox-gate.ts extensions/_shared/sandbox-gate.test.ts
git commit -m "feat(approval): sandboxOn 统一沙箱判据（SANDBOX_ENABLE+策略+可用性）（任务 2）"
```

### 任务 3：approval 扩展

**文件：** 创建 `extensions/approval/index.ts`、`extensions/approval/package.json`；修改 `extensions/index.ts`

- [ ] **步骤 1：实现扩展**（复刻 agent-mode 的 命令/持久化/session_start/setStatus 骨架）
```ts
// approval：审批策略（ask/auto/full）的命令 + 持久化 + 状态回推。复刻 agent-mode 状态流。
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ApprovalPolicy, APPROVAL_LABELS, getApprovalPolicy, parseApproval, setApprovalPolicy } from "../_shared/approval.js";

interface PersistedState { policy?: ApprovalPolicy }

export default function (pi: ExtensionAPI) {
  const persist = () => pi.appendEntry("approval", { policy: getApprovalPolicy() } satisfies PersistedState);
  const push = (ctx: ExtensionContext) => ctx.ui.setStatus("approval-policy", getApprovalPolicy());

  pi.registerCommand("approval", {
    description: "切换审批策略：/approval ask|auto|full",
    handler: async (args, ctx) => {
      const next = parseApproval(args);
      if (!next) {
        ctx.ui.notify(`用法：/approval ask|auto|full（当前：${getApprovalPolicy()}）`, "warning");
        return;
      }
      setApprovalPolicy(next);
      persist();
      push(ctx);
      ctx.ui.notify(`审批策略：${APPROVAL_LABELS[next]}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown }>;
    const entry = entries.filter((e) => e.type === "custom" && e.customType === "approval").pop();
    const data = entry?.data as PersistedState | undefined;
    setApprovalPolicy(parseApproval(data?.policy) ?? "auto");
    push(ctx);
  });
}
```

- [ ] **步骤 2：`package.json`**
```json
{ "name": "pi-approval", "version": "0.1.0", "type": "module", "pi": { "extensions": ["./index.ts"] }, "devDependencies": { "@earendil-works/pi-coding-agent": "*" } }
```

- [ ] **步骤 3：注册** — `extensions/index.ts`：`import approval from "./approval/index.js";` 加入 `export { ... approval }` 与 `allExtensions` 数组（放在 safety 之后、靠前，保证 session_start 早于消费者读取）。

- [ ] **步骤 4：测试** `extensions/approval/index.test.ts`（复刻 code-exec/index.test 风格，断言注册了 `approval` 命令）
```ts
import { describe, expect, it } from "vitest";
import approval from "./index.js";
describe("approval extension", () => {
  it("registers the approval command", () => {
    const cmds: string[] = [];
    const pi = { registerCommand: (n: string) => cmds.push(n), on: () => {}, appendEntry: () => {} };
    approval(pi as unknown as Parameters<typeof approval>[0]);
    expect(cmds).toEqual(["approval"]);
  });
});
```
运行：`npx vitest run approval` → PASS。

- [ ] **步骤 5：Commit**
```powershell
git add extensions/approval extensions/index.ts
git commit -m "feat(approval): approval 扩展（/approval 命令 + 持久化 + setStatus）+ 注册（任务 3）"
```

## Phase 2：safety + 沙箱消费者接线

### 任务 4：safety 按策略门控

**文件：** 修改 `extensions/safety/index.ts`（已 import getConfig；加 getApprovalPolicy）

- [ ] **步骤 1：实现** —— `tool_call` hook 开头加策略分支
```ts
import { getApprovalPolicy } from "../_shared/approval.js";
// …tool_call 内最前：
const policy = getApprovalPolicy();
if (policy === "full") return undefined; // 完全访问：放行一切

// ask：额外对「写 cwd 外」「联网」弹确认（在既有 readonly/deny/危险bash 之外）
if (policy === "ask") {
  const net = event.toolName === "web_search" || event.toolName === "web_fetch" || event.toolName === "web_crawler";
  if (net) {
    if (!ctx.hasUI) return { block: true, reason: "请求批准模式：无 UI，默认拒绝联网" };
    const ok = await ctx.ui.confirm("允许联网？", `工具：${event.toolName}`);
    if (!ok) return { block: true, reason: "用户拒绝联网" };
  }
  if (event.toolName === "write" || event.toolName === "edit") {
    const p = extractPath((event.input ?? {}) as Record<string, unknown>);
    if (p && !isUnderCwd(p, ctx.cwd)) {
      if (!ctx.hasUI) return { block: true, reason: "请求批准模式：无 UI，默认拒绝越界写" };
      const ok = await ctx.ui.confirm("允许写工作区外文件？", p);
      if (!ok) return { block: true, reason: "用户拒绝越界写" };
    }
  }
}
// …随后是既有 denyTools / readonly / 危险bash / 受保护路径逻辑（auto 与 ask 共用）
```
新增 `isUnderCwd(p, cwd)` 到 `extensions/safety/rules.ts`（normalize 后判断前缀；复用既有 path 工具）：
```ts
import { resolve } from "node:path";
export function isUnderCwd(p: string, cwd: string): boolean {
  const a = resolve(cwd);
  const b = resolve(cwd, p);
  return b === a || b.startsWith(a + (a.endsWith("/") || a.endsWith("\\") ? "" : require("node:path").sep));
}
```
（实现时按仓库风格用 `import { sep } from "node:path"` 而非 require。）

- [ ] **步骤 2：测试** `extensions/safety/index.test.ts`（若无则新建）：注入 `getApprovalPolicy` + 假 `ctx.ui.confirm`，覆盖 full 放行 / ask 越界写确认 / ask 联网确认 / auto 不对越界写弹。并为 `isUnderCwd` 在 `rules.test.ts` 加纯单测（cwd 内/外、`../` 逃逸）。
- [ ] **步骤 3：运行** `npx vitest run safety` → PASS。
- [ ] **步骤 4：Commit**
```powershell
git add extensions/safety/index.ts extensions/safety/rules.ts extensions/safety/rules.test.ts extensions/safety/index.test.ts
git commit -m "feat(approval): safety 按策略门控（full放行/ask越界+联网确认/auto现状）（任务 4）"
```

### 任务 5：沙箱消费者改用 `sandboxOn()`

**文件：** 修改 `extensions/code-exec/sandbox-exec.ts`、`extensions/im-platforms/index.ts`、`extensions/multi-agent/index.ts`

- [ ] **步骤 1：code-exec** —— `sandbox-exec.ts` 把 `sandboxRoutingOn()`（原 `getConfig==="on"`）改为复用 `sandboxOn()`：
```ts
import { sandboxOn } from "../_shared/sandbox-gate.js";
// runCodeInSandbox 内：if (!(await sandboxOn())) return null; // 取代原 isAvailable 检查
```
并把 `index.ts` 里 `if (sandboxRoutingOn())` 改为始终调用 `runCodeInSandbox`（其内部用 `sandboxOn()` 判定，返回 null 即回退本地内核）。删除 `sandboxRoutingOn`。

- [ ] **步骤 2：im-platforms** —— `runImTurn` 内 `sandboxed = restricted && (await getSandbox().isAvailable())` 改为 `sandboxed = restricted && (await sandboxOn())`（import sandboxOn）。

- [ ] **步骤 3：multi-agent** —— `if (wantSandbox && (await getSandbox().isAvailable()))` 改为 `if (wantSandbox && (await sandboxOn()))`。

- [ ] **步骤 4：运行** `npx vitest run code-exec im-platforms multi-agent` → PASS（CI 无 WSL→sandboxOn 假→回退，行为不变）。
- [ ] **步骤 5：Commit**
```powershell
git add extensions/code-exec extensions/im-platforms/index.ts extensions/multi-agent/index.ts
git commit -m "feat(approval): 沙箱消费者改用 sandboxOn() 统一判据（任务 5）"
```

## Phase 3：前端 + Tauri

### 任务 6：approvalStore + 测试

**文件：** 创建 `tauri-agent/src/stores/approvalStore.ts`、`approvalStore.test.ts`（复刻 modeStore）

- [ ] **步骤 1：实现**
```ts
import { create } from "zustand";
export type ApprovalPolicy = "ask" | "auto" | "full";
export const APPROVAL_POLICIES: ApprovalPolicy[] = ["ask", "auto", "full"];
export const APPROVAL_LABELS: Record<ApprovalPolicy, string> = { ask: "请求批准", auto: "替我审批", full: "完全访问" };
interface S { byWorkspace: Record<string, ApprovalPolicy>; setLevel: (ws: string, p: ApprovalPolicy) => void; }
export const useApprovalStore = create<S>((set) => ({
  byWorkspace: {},
  setLevel: (ws, p) => set((s) => ({ byWorkspace: { ...s.byWorkspace, [ws]: p } })),
}));
```
- [ ] **步骤 2：测试**（set/get by workspace）→ PASS。
- [ ] **步骤 3：Commit**
```powershell
git add tauri-agent/src/stores/approvalStore.ts tauri-agent/src/stores/approvalStore.test.ts
git commit -m "feat(approval): approvalStore（per-workspace）（任务 6）"
```

### 任务 7：pi.setApproval + ExtensionUiHost + ApprovalAction

**文件：** 修改 `tauri-agent/src/lib/pi.ts`、`features/extensionUi/ExtensionUiHost.tsx`；创建 `features/chat/input/actions/ApprovalAction.tsx`；挂到工具条

- [ ] **步骤 1：pi.ts** —— `pi` 对象加 `setApproval: (workspace, level) => invoke<unknown>("agent_set_approval", { workspace, level })`。
- [ ] **步骤 2：ExtensionUiHost** —— setStatus 分支加：
```ts
} else if (r.statusKey === "approval-policy") {
  if (typeof r.statusText === "string") useApprovalStore.getState().setLevel(e.workspace, r.statusText as ApprovalPolicy);
}
```
- [ ] **步骤 3：ApprovalAction.tsx**（复刻 ModeAction，图标 ShieldAlert/Shield/ShieldOff）
```tsx
import { Icon } from "@lobehub/ui";
import { Select } from "@lobehub/ui/base-ui";
import { Shield, ShieldAlert, ShieldOff, type LucideIcon } from "lucide-react";
import { useAgentStoreContext } from "../../../../stores/AgentStoreContext";
import { pi } from "../../../../lib/pi";
import { APPROVAL_POLICIES, APPROVAL_LABELS, useApprovalStore, type ApprovalPolicy } from "../../../../stores/approvalStore";

const ICONS: Record<ApprovalPolicy, LucideIcon> = { ask: ShieldAlert, auto: Shield, full: ShieldOff };

export default function ApprovalAction() {
  const { workspace, workspaceReady } = useAgentStoreContext();
  const level = useApprovalStore((s) => s.byWorkspace[workspace] ?? "auto");
  const onChange = (next: string) => {
    useApprovalStore.getState().setLevel(workspace, next as ApprovalPolicy);
    void pi.setApproval(workspace, next as ApprovalPolicy);
  };
  return (
    <Select
      size="small"
      popupMatchSelectWidth={false}
      disabled={!workspaceReady}
      value={level}
      options={APPROVAL_POLICIES.map((p) => ({ label: APPROVAL_LABELS[p], value: p }))}
      optionRender={(o) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Icon icon={ICONS[o.value as ApprovalPolicy]} size={14} />
          {APPROVAL_LABELS[o.value as ApprovalPolicy]}
        </span>
      )}
      placeholder="审批"
      prefix={ICONS[level]}
      style={{ width: "auto", maxWidth: 120 }}
      onChange={onChange}
    />
  );
}
```
- [ ] **步骤 4：挂载** —— 在渲染 `<ModeAction/>` 的工具条组件里同级加 `<ApprovalAction/>`（实现时 grep `ModeAction` 用法定位，通常 `features/chat/input/.../*.tsx`）。
- [ ] **步骤 5：测试 + 构建** —— `cd tauri-agent && npx vitest run approval extensionUi && npx tsc --noEmit` → PASS。
- [ ] **步骤 6：Commit**
```powershell
git add tauri-agent/src/lib/pi.ts tauri-agent/src/features/extensionUi/ExtensionUiHost.tsx tauri-agent/src/features/chat/input/actions/ApprovalAction.tsx <工具条文件>
git commit -m "feat(approval): 前端 ApprovalAction 下拉 + 状态回推 + setApproval（任务 7）"
```

### 任务 8：Tauri `agent_set_approval`

**文件：** 修改 `tauri-agent/src-tauri/src/commands/agent.rs`、`lib.rs`

- [ ] **步骤 1：实现**（复刻 `agent_set_mode`：向 sidecar 发 `/approval <level>` 命令）。grep `agent_set_mode` 找到其实现，照搬改命令名与参数。
- [ ] **步骤 2：注册** lib.rs invoke_handler 加 `commands::agent_set_approval`（或对应路径）。
- [ ] **步骤 3：`cargo check`** → 通过。
- [ ] **步骤 4：Commit**
```powershell
git add tauri-agent/src-tauri/src/commands/agent.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(approval): Tauri agent_set_approval 命令（任务 8）"
```

### 任务 9：端到端冒烟（手动）
- [ ] `npm run build:sidecar` + 重建 app。
- [ ] 输入框出现「审批」下拉，默认替我审批；切「请求批准」后让 agent 写工作区外文件 / 联网 → 弹确认；切「完全访问」→ 不弹、不隔离；切会话回读保持。

---

## 自检

**规格覆盖度：** 共享策略→任务1；沙箱判据→任务2；扩展(命令/持久化/状态)→任务3；safety 门控→任务4；消费者接线→任务5；前端 store/下拉/状态/命令→任务6-8；e2e→任务9。

**占位符扫描：** 任务4/7/8 标「实现时 grep 定位」是对齐指令（agent_set_mode / ModeAction 挂载点为现成模板），核心逻辑已给全。`isUnderCwd` 的 require 注释提示改用 `import { sep }`。

**类型一致：** `ApprovalPolicy`("ask"|"auto"|"full")、`getApprovalPolicy/setApprovalPolicy/parseApproval/APPROVAL_LABELS`、`sandboxOn()`、`useApprovalStore.setLevel`、`pi.setApproval`、`agent_set_approval` 全程一致。前后端各有一份 ApprovalPolicy/labels（扩展侧 `_shared/approval.ts`、前端 `approvalStore.ts`），值一致。

---

## 实现落地说明（2026-06-19 回填，以代码为准）

下列任务的最终实现相对上方 TDD 代码块有有意演进（功能已落地并通过测试）；上方代码块为历史草案，**实际以对应实现文件为准**：

- **任务 2（`sandbox-gate.ts`）**：最终暴露**两个**判据而非单个 `sandboxOn`：`sandboxAvailable()`（策略无关：`SANDBOX_ENABLE≠off` 且可用）+ `sandboxOn()`（在其上再要求策略≠full）。测试同覆盖两者。
- **任务 3（approval 扩展）**：`session_start` 回读顺序为 session entry → `parseApproval(getConfig("APPROVAL_POLICY"))`（子代理由父进程注入，实现策略继承）→ 默认 `auto`。
- **任务 4（safety 门控）**：确认 UI 用 `ctx.ui.select(msg,["允许","拒绝"])`（非 `confirm`）；`ask` 在 **headless 降级为 auto、不阻断**（非「无 UI 默认 block」）；`ask` 额外覆盖外部 MCP 工具（`mcp__*`）。门控顺序见 `safety/index.ts` 的 ①~⑤ 注释。
- **任务 5（消费者接线）**：code-exec 用 `sandboxOn()`；**im-platforms / multi-agent 改用 `sandboxAvailable()`**（不可信/显式隔离不被 owner 的 full 关掉），而非计划中统一的 `sandboxOn()`。
- **任务 7（ApprovalAction 图标）**：`Hand`/`Shield`/`ShieldAlert`（对齐 Codex），非 `ShieldAlert/Shield/ShieldOff`。
- **相关评审修复 commits**：`c9a4a39c`（full 不越子代理能力闸 / project_trust 认 full / ask 补 shell 越界写 / 子代理继承策略 headless 降级 auto）、`b07bff5f`（ask 拦 MCP + 网络）、`5a53396a`（mcp manager 写缓存用全名 `mcp__server__tool`）。
