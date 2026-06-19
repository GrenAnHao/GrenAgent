# 审批策略（Approval Policy · Codex 式三级预设）设计

- 日期：2026-06-19
- 状态：设计已评审（待用户最终确认 → writing-plans）
- 主题：在 Pi 桌面端新增一个与「模式（Agent/Ask/Debug/Plan）」并列的**审批策略**选择器，对标 Codex 的三级（请求批准 / 替我审批 / 完全访问）。每级是一个**预设**，同时配置「沙箱 scope + 确认级别」，打通已落地的 safety（逐操作确认）与统一沙箱层（WSL2）。

## 1. 背景与目标

现有两条相关机制：
- **agent-mode**（`extensions/agent-mode/`）：统一模式 Agent/Ask/Debug/Plan，管「工具范围（读写）」；经 `setStatus("agent-mode")` 推前端，`ModeAction.tsx` 渲染输入框下拉，per-session 持久化。
- **safety**（`extensions/safety/`）：逐操作审批——危险命令 `ctx.ui.confirm`、受保护路径拦写、`project_trust`。配置 `SAFETY_*`。
- **统一沙箱层**（`extensions/_shared/sandbox/`，已落地）：WSL2 + srt 隔离执行，消费者 code-exec / im-platforms / multi-agent。

缺一个用户可见的「确认/权限级别」控制。Codex 把它做成三级预设（截图：请求批准 / 替我审批 / 完全访问），每级描述同时涉及「沙箱（文件/网络范围）+ 何时询问」。本设计补齐这一维度。

### 成功标准（用户确认）

1. **独立维度**：新增「审批策略」下拉，与模式选择器**并列**（模式=工具范围，审批=确认级别 + 沙箱 scope）。对标 Codex 把 sandbox 与 approval 分离呈现。
2. **三级为预设**，每级同时控「沙箱 scope + 确认级别」：
   - **请求批准**：沙箱开（可用时）；写 workspace 外 / 联网 / 危险命令 → 弹确认。
   - **替我审批（默认）**：沙箱开（可用时）；仅危险命令 → 弹确认。
   - **完全访问**：关沙箱；不确认、不限制（宿主直跑）。
3. **默认「替我审批」**，**per-session 持久化**（复刻 agent-mode），切会话/重启回读。
4. **复用现有机制**：确认走 `ctx.ui.confirm`（ExtensionUiHost 内联卡）；前端下拉复刻 `ModeAction`；状态流复刻 agent-mode。

### 关键决策（来自评审问答）

- 审批与模式**正交、并列两个下拉**（非合并、非替换）。
- 三级=预设，**耦合沙箱 + 确认**（用户明确选此，对标 Codex 的混合 UX）。
- 默认 `auto`（替我审批），per-session。
- 沙箱开关从 `SANDBOX_ENABLE==="on"` 改为「**策略 != full 且沙箱可用**」驱动；`SANDBOX_ENABLE=off` 保留为总 kill 开关。
- owner 默认（auto）即沙箱开——接受 owner code-exec 进沙箱（常驻内核退化为一次性 + 首次探测延迟）。

### 非目标（YAGNI）

- 不做 per-tool 细粒度自定义白名单 UI（先三级预设）。
- 不改 agent-mode 的 Agent/Ask/Debug/Plan 语义（仅并列新增）。
- 不做全局（跨 workspace）策略（先 per-session，与 agent-mode 一致）。
- 不在本设计内新增沙箱后端（复用已落地的 WSL2 层）。

## 2. 架构总览（复刻 agent-mode 的状态流）

```
前端 ApprovalAction.tsx（输入框下拉，复刻 ModeAction）
  └─ onChange → approvalStore 乐观更新 + pi.setApproval(workspace, level)
        └─ Tauri agent_set_approval → sidecar /approval 命令（不调 LLM）
              └─ approval 扩展：setApprovalPolicy(level) 写进程内共享态
                                + appendEntry 持久化到 session
                                + setStatus("approval-policy", level) 回推前端
前端 ExtensionUiHost 收 setStatus("approval-policy") → approvalStore.setLevel

读取方（同一 sidecar 进程内）：
  _shared/approval.ts  getApprovalPolicy(): "ask" | "auto" | "full"
   ├─ safety/index.ts        tool_call 据此决定 confirm / 放行
   └─ code-exec / im-platforms / multi-agent   据此决定是否走沙箱
```

数据流与 agent-mode 完全同构：命令 → 扩展改状态 → 持久化 + setStatus → 前端 store 回读。

## 3. 组件

### 3.1 `extensions/_shared/approval.ts`（新）
进程内共享策略单例（多扩展读同一份）。
```ts
export type ApprovalPolicy = "ask" | "auto" | "full";
export function getApprovalPolicy(): ApprovalPolicy;   // 默认 "auto"
export function setApprovalPolicy(p: ApprovalPolicy): void;
export function parseApproval(s: string | undefined): ApprovalPolicy | undefined;
export const APPROVAL_LABELS: Record<ApprovalPolicy, string>; // 请求批准/替我审批/完全访问
```

### 3.2 `extensions/approval/index.ts`（新，复刻 agent-mode 骨架）
- `pi.registerCommand("approval", …)`：`/approval ask|auto|full`，设 `setApprovalPolicy` + persist + setStatus + notify。
- `pi.on("session_start")`：从 session entry 回读（无则 default auto）→ setApprovalPolicy + `setStatus("approval-policy", level)`。
- persist：`pi.appendEntry("approval", { policy })`。

### 3.3 safety 改造（`extensions/safety/index.ts`）
`tool_call` 按以下顺序门控（实现见 index.ts 的 ①~⑤ 注释）：
- ① **能力硬限**（`SAFETY_DENY_TOOLS` / `SAFETY_READONLY` + `SAFETY_WRITE_ALLOW`，优先读 `process.env`）——任何策略（含 full）都不得越过，保证子代理能力闸不被主 agent 放宽。
- ② `full`：在 ① 之后 `return undefined`，跳过余下面向用户的确认/保护。
- ③ 沙箱激活（`sandboxOn()`）时禁内置 `bash`，steer 到 `sandbox_sh`（隔离执行）。
- ④ `ask` 且 `ctx.hasUI`：逐次确认，用 `ctx.ui.select(msg, ["允许","拒绝"])`（非 `confirm`）：
  - 外部 MCP 工具（`mcp__*`，含 fetch 等）或联网工具 `web_search`/`web_fetch`/`web_crawler` → 确认。
  - `write`/`edit` 目标在 `ctx.cwd` 外（`isUnderCwd` 判定）→ 确认。
  - 会改动文件的 bash 且沙箱不可用（`!sandboxAvailable()`）→ 确认（沙箱可用时 bash 已被 ③ 禁）。
  - **headless（`!ctx.hasUI`，如子代理）降级为 auto 行为、不阻断**——避免继承 ask 的子代理被全拦；仍受 ⑤ 兜底。
- ⑤ 既有兜底（auto 与 ask 共用）：危险 bash 确认（`SAFETY_BASH_CONFIRM`）+ 受保护路径拦写（`SAFETY_PROTECT_PATHS`）。

### 3.4 沙箱联动（code-exec / im-platforms / multi-agent）
判据从 `getConfig("SANDBOX_ENABLE")==="on"` 改为 `_shared/sandbox-gate.ts` 的**两个**函数（按场景择一）：
```ts
// 策略无关的可用性：SANDBOX_ENABLE≠off 且 WSL2 沙箱就绪。
sandboxAvailable() = getConfig("SANDBOX_ENABLE") !== "off" && await getSandbox().isAvailable()
// 策略感知：在可用之上再要求审批策略 ≠ full（owner 选「完全访问」即宿主直跑、不隔离）。
sandboxOn() = getApprovalPolicy() !== "full" && await sandboxAvailable()
```
- **owner 自己会话**（code-exec js_run/py_run、safety 禁内置 bash）用 `sandboxOn()`——尊重 owner 的「完全访问」可关沙箱。
- **不可信/显式隔离**（im-platforms 无主人会话、multi-agent `isolation:"sandbox"`）用 `sandboxAvailable()`——这类隔离由场景本身要求，不应被 owner 个人的「完全访问」关掉。
- im-platforms 仍保留「无主人 + 沙箱不可用 → 纯 deny」兜底。

### 3.5 前端
- `stores/approvalStore.ts`（复刻 modeStore）：`byWorkspace: Record<ws, ApprovalPolicy>`，`setLevel(ws, p)`。
- `features/chat/input/actions/ApprovalAction.tsx`（复刻 ModeAction）：base-ui Select + lucide 图标（请求批准=`Hand` / 替我审批=`Shield` / 完全访问=`ShieldAlert`，对齐 Codex），onChange → store 乐观 + `pi.setApproval`。
- `lib/pi.ts`：`setApproval(ws, level) => invoke("agent_set_approval", { workspace, level })`。
- `features/extensionUi/ExtensionUiHost.tsx`：`statusKey === "approval-policy"` → `approvalStore.setLevel`。
- 输入框工具条挂上 `<ApprovalAction/>`（ModeAction 旁）。

### 3.6 Tauri（`src-tauri/src/commands/agent.rs` 或同处）
`agent_set_approval(workspace, level)`：复刻 `agent_set_mode`，向 sidecar 发 `/approval <level>`。lib.rs 注册。

## 4. 三级预设 → 行为对照

| 级别 | 沙箱（可用时） | 写 workspace 外 | 联网 | 外部 MCP 工具 | 危险命令 | 普通读写/安全命令 |
| --- | --- | --- | --- | --- | --- | --- |
| 请求批准 ask | 开 | 确认 | 确认 | 确认 | 确认 | 自动 |
| 替我审批 auto（默认） | 开 | 自动 | 自动 | 交 mcp-policy 按工具裁决 | 确认 | 自动 |
| 完全访问 full | 关 | 自动 | 自动 | 自动 | 自动 | 自动 |

> 注：`ask` 对所有 `mcp__*` 工具统一确认一次（粗粒度策略闸）；`auto`/`full` 不在 safety 层拦 MCP，交由 `mcp-policy` 扩展按 per-tool 权限 + danger 启发式细粒度裁决。为避免双弹，`ask` 策略下 `mcp-policy` 经 `decide(..., approvalAsk=true)` 跳过 needs_approval/danger 的二次确认（`disabled` 硬禁用、headless 拦截仍生效）。

## 5. 降级 / 持久化 / 确认 UI

- 沙箱未装：ask/auto 仍生效——确认在宿主侧照常弹，只是执行无隔离；SandboxCard 引导一键安装。
- 持久化：`pi.appendEntry("approval", {policy})` + session_start 回读，默认 auto。per-session（多会话各自独立）。
- 确认 UI：复用 `ctx.ui.confirm` → `pi://ui-request`(confirm) → ExtensionUiHost → 输入框上方内联卡（已支持）。

## 6. 测试

- `_shared/approval.ts`：get/set/parse/默认 纯单测。
- safety 改造：注入 `getApprovalPolicy` + 假 ctx.ui.confirm，断言 full 放行 / auto 现状 / ask 对越界写+联网+危险命令弹确认（用 rules 的 extractPath / isDangerousBash）。
- 沙箱判据：策略=full 时不路由（单测 sandboxOn 逻辑）。
- 前端：approvalStore + ApprovalAction（复刻 ModeAction 测试）+ ExtensionUiHost 收 approval-policy 状态。
- Rust：`cargo check`。

## 7. 风险 / 待验证

- **owner 默认进沙箱**：auto 默认 → owner code-exec 进沙箱（内核退化 + 探测延迟）。已确认接受；若体验差可把默认沙箱仅对「无主人/子代理」生效（保留开关）。
- **ask 的越界判定**：`write/edit` 的路径解析要 normalize（`../`、symlink、盘符大小写），复用 safety/rules 既有 `extractPath`/路径匹配。
- **confirm 风暴**：ask 级别下密集越界操作可能频繁弹窗；可后续加「本会话记住此目录」一类记忆（YAGNI，先不做）。

## 8. 实现落地与设计差异（2026-06-19 回填）

实现期相对本设计的有意演进，已反映到上文，集中记录如下：

- **确认 UI 用 `ctx.ui.select(msg, ["允许","拒绝"])` 而非 `ctx.ui.confirm`**：与 mcp-policy 的审批卡片统一为 select。
- **`ask` 在 headless 降级为 auto**（原设计「无 UI 默认 block」）：子代理经 `APPROVAL_POLICY` env 继承 owner 策略；若 ask 在 headless 全拦，继承 ask 的子代理将无法执行任何越界/联网/MCP 操作。故 headless 不阻断，仅保留 ⑤ 危险命令/受保护路径兜底。
- **`ask` 覆盖外部 MCP 工具**（`mcp__*`）：原设计仅列内置 `web_*`；因 mcp-policy 默认 `auto` 不拦 MCP，ask 需自行覆盖以兑现「请求批准=对外部能力都问」。
- **沙箱判据拆为 `sandboxOn()` + `sandboxAvailable()`**：见 §3.4。owner 会话尊重 full 关沙箱；不可信/显式隔离只看可用性。
- **子代理策略继承**：`approval` 扩展 `session_start` 回读顺序为 session entry → `APPROVAL_POLICY` env（父进程注入）→ 默认 auto；multi-agent spawn 时注入 `profileEnv.APPROVAL_POLICY = getApprovalPolicy()`。能力硬限（①）在 full 之前先行，full 不越子代理 deny/readonly 闸。
- **双层 MCP 审批去重**：`ask` 策略下 safety 已统一确认所有 `mcp__*`，`mcp-policy` 经 `decide(..., approvalAsk=true)` 把 needs_approval/danger 的 prompt 降级为 pass，避免二次弹窗；`disabled` 硬禁用与 headless 拦截不受影响。
- **前端图标**：`Hand`/`Shield`/`ShieldAlert`（对齐 Codex），非早期设计的 `ShieldAlert/ShieldCheck/ShieldOff`。

## 9. 执行/写/网工具的能力闸与审批覆盖加固（2026-06-19）

一次自递归审查发现多个「自有副作用工具」绕过能力闸/审批，已修复，并引入 `extensions/_shared/tool-groups.ts` 作为工具分组的**单一真相源**（safety 与 multi-agent/im-platforms 共用，避免两处清单漂移）：

- **NET_TOOLS 工具名失配（严重）**：safety 与 capability 原用 `web_fetch`/`web_crawler`（不存在的幻影名），漏掉真实联网工具 `search`/`fetch_url`/`fetch_llms`/`fetch_github_readme`/`fetch_web_content`/`github` → `ask` 联网确认与 `net:false` 几乎只命中 `web_search`。现统一为 `NET_TOOLS` 真实全集。
- **写盘工具绕过 readonly**：`ast_edit`/`hl_edit` 直接 `writeFileSync`，不经 write/edit 白名单。safety readonly 现直接拦 `WRITE_TOOLS`；capability `fs:readonly`/`writeAllow` 一并 deny。
- **代码执行绕过**：`py_run`/`js_run`/`sandbox_sh`/`dap_launch`/`dap_evaluate` 不经 bash 闸。capability 受限 fs 时 deny `CODE_EXEC_TOOLS`；safety `ask` 对宿主执行（`dap_*`，及沙箱不可用时的 `py_run`/`js_run`）二次确认（沙箱可用时 `py_run`/`js_run` 进沙箱、免确认）。
- **im-platforms 受限会话**：deny 拆为「始终禁」（写盘/调试执行/github，不经沙箱、绕过隔离）+「无沙箱额外禁」（bash/可沙箱化执行），保留联网查询能力（受限会话靠它读取信息回答问题）。
