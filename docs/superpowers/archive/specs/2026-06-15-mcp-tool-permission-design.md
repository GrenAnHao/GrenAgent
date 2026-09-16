# MCP 工具权限控制 — 设计

- 日期：2026-06-15
- 状态：设计待审（brainstorming 产出）
- 范围：阶段 1 = 新增 `extensions/mcp-policy/`（纯 extension）；阶段 2 = `tauri-agent` 前端权限面板
- 参考：lobehub MCP/插件管控范式（connector 三态权限 + manifest `humanIntervention` + 运行时多层拦截）

## 1. 目标

为 Pi 的 MCP 工具调用建立一套权限控制，对齐 lobehub 的核心范式，但落到 Pi 的桌面 sidecar + extension 架构上、尽量轻量：

1. 单工具三态权限：`auto` / `needs_approval` / `disabled`
2. 调用时审批（含「总是允许」记忆）
3. 参数级审批规则（借鉴 lobehub `humanIntervention`）
4. 调用审计日志
5. server 级启停沿用现有机制，不重复造

成功标准：MCP 工具不再「连上即无条件可调」；用户能按工具/参数粒度决定放行、审批或禁用；审批结果可记忆且即时生效（不重启 sidecar）；命令行/headless 模式有安全的默认行为。

## 2. 背景与现状

### 2.1 Pi MCP 现状

- 实现：`extensions/mcp/`（包 `pi-mcp`），用官方 `@modelcontextprotocol/sdk` 的 `Client`，支持 `stdio` + `sse`。
- 配置：环境变量 `MCP_SERVERS`（JSON，兼容 `.cursor/mcp.json` 的 `{ mcpServers: {...} }`），默认注入 `open-websearch`。
- 加载：首次 `session_start` 后台并发连接 → `client.listTools()` → 每个工具 `pi.registerTool()` 注册为 `mcp__<server>__<tool>` → `setActiveTools()` 激活。
- 调用：工具 `execute` 直接 `client.callTool()` 转发。
- 权限：**零控制**。连上即全量注册并激活，`execute` 无任何拦截。

### 2.2 可复用的现成基础设施

- `pi.on("tool_call", ...)` 钩子：同步可异步，返回 `{ block: true, reason }` 即拦截。`extensions/safety/` 已用它管危险 bash / 受保护路径。
- 审批 UI 通道：sidecar 的 `ctx.ui.select / confirm / input / notify` → Rust 收到 `extension_ui_request`（`tauri-agent/src-tauri/src/pi/types.rs` 的 `ExtensionUiRequest`、`pi/client.rs` 路由到前端）→ 前端弹真实窗口 → 回传。**调用时审批不需要新 IPC。**
- `ctx.hasUI`：判断当前是否有前端（headless / 命令行模式为 false）。
- server 级启停：已实现，前端 `ExtensionsPanel` 通过 `MCP_SERVERS`（启用集）/ `MCP_SERVERS_DISABLED`（禁用集）管理，settings → Rust 注入 env → sidecar spawn，**改动重启 sidecar 生效**。
- 工具名统一前缀 `mcp__<server>__<tool>`，天然适合按 server/tool 粒度匹配策略。

### 2.3 lobehub 参考结论

lobehub 把授权拆成「配置态」（DB 单工具三态 `auto/needs_approval/disabled` + Settings UI）与「运行时态」（agent runtime 在 tool_call 前按 `humanIntervention` 挂起审批 + 多层 `disabled` 硬拦截），并支持参数级 `humanIntervention` 规则与安全黑名单；`limitConfig`（输入白名单/输出限制）已建模但未实现。本设计提取其精华，省略其重型的 DB/tRPC/服务端 runtime 部分。

## 3. 设计决策（brainstorming 已确认）

| 维度 | 决策 |
|------|------|
| 作用域 | 全局一套，跨工作区共享（`~/.pi/mcp-policy.json`） |
| 审批 UI | 复用 `ctx.ui.select` 文本弹窗（零新 IPC） |
| 策略存储/生效 | 独立策略文件，`tool_call` 钩子运行时读，「总是允许」即时写回不重启 |
| 新工具默认态 | `auto`（除非命中危险默认规则） |
| headless 行为 | 需审批的工具一律 `block`（安全优先，对齐 safety） |
| disabled 可见性 | 不预先告知模型，调用时才 `block`（保「即时生效不重启」） |
| 全局 auto-run 逃生舱 | 不做（YAGNI），仅按各工具自身三态走 |
| 代码归属 | 独立扩展 `extensions/mcp-policy/` |
| server 级启停 | 沿用 `MCP_SERVERS` / `MCP_SERVERS_DISABLED`（重启），仅 tool 级即时 |

## 4. 范围与边界

**本设计负责（tool 级及以下）：**

- tool 三态权限、参数级规则、调用时审批与记忆、审计日志。

**非目标（明确不做）：**

- 不接管 server 级启停（继续走 `MCP_SERVERS` / `MCP_SERVERS_DISABLED`，重启生效）。
- 不做全局 `auto-run` 一键放行开关。
- 不做参数「重写/脱敏注入」或输出长度强制（对应 lobehub 未实现的 `limitConfig`，留作未来扩展点）。
- 不改 Pi core，不改 `extensions/mcp/` 的连接逻辑（拦截在独立扩展里完成）。

## 5. 架构：单一拦截点

所有 MCP 工具照常注册并激活；**权限判断全部集中在新扩展 `mcp-policy` 的一个 `tool_call` 钩子**里。策略改动即时生效，无需重新注册工具或重启。

```
LLM 决定调用 mcp__<server>__<tool>
        │
        ▼
  tool_call 钩子 (mcp-policy)            ← 仅处理 toolName 以 "mcp__" 开头者，其余放行
   loadPolicy()  (进程内缓存 + mtime 检测)
   decide(toolName, args, hasUI) → PASS | BLOCK(reason) | PROMPT(recordable, summary)
        │
   ┌────┴───────────┬───────────────────┬───────────────────┐
 PASS            PROMPT(有UI)         PROMPT(无UI)        BLOCK
 放行             ctx.ui.select         block(headless)    block(disabled/规则)
                 [允许本次 /
                  总是允许(仅recordable) /
                  拒绝]
        │
        ▼
   审计追加 (~/.pi/mcp-audit.jsonl)
        │
   放行 → 原 mcp execute → client.callTool 转发
```

机制与 `extensions/safety/` 的 `tool_call` + `ctx.ui.select` 完全同款，已验证可用。两个扩展互不冲突：safety 管内置 `bash/write/edit`，mcp-policy 只管 `mcp__*`。

## 6. 策略文件结构 `~/.pi/mcp-policy.json`

```json
{
  "version": 1,
  "defaultPermission": "auto",
  "tools": {
    "mcp__github__create_issue": { "permission": "needs_approval" },
    "mcp__fs__delete_file": {
      "permission": "auto",
      "rules": [
        { "match": { "path": "/etc/**" }, "policy": "always" },
        { "policy": "never" }
      ]
    },
    "mcp__shell__run": { "permission": "disabled" }
  },
  "audit": { "enabled": true }
}
```

- 路径：sidecar（Node）用 `path.join(os.homedir(), ".pi", "mcp-policy.json")`；阶段 2 前端用同一绝对路径，保证跨进程一致。与项目级 `.pi/`（prompts/skills）不同，这是用户级全局目录。
- `defaultPermission`：文件无该工具记录时的默认态，默认 `auto`。
- `tools[name].permission`：三态 `auto | needs_approval | disabled`。
- `tools[name].rules`：参数级规则数组，按顺序匹配，第一个命中生效。
  - `match`：键到值模式的映射；值支持 `*` 通配（简单 glob，自实现，不引依赖）。省略 `match` 表示无条件命中（兜底项）。
  - `policy`：`never`（免审）/ `required`（需审、可记忆）/ `always`（每次必审、不可记忆）。
- `audit.enabled`：审计开关，默认 `true`。

文件不存在或解析失败 → 视为空策略（全部走 `defaultPermission`），不报错、不阻断。

## 7. 决策逻辑 `decide(toolName, args, hasUI)`

纯函数，定义在 `policy.ts`，输出三选一：`PASS` / `BLOCK(reason)` / `PROMPT(recordable, summary)`。

```
if not toolName.startsWith("mcp__"): return PASS        # 非 MCP 工具不归本扩展管

entry = policy.tools[toolName]
perm  = entry?.permission ?? policy.defaultPermission ?? "auto"

# 1) disabled 最先，直接拦截
if perm == "disabled": return BLOCK("该工具已被禁用，可在 MCP 权限设置中启用")

# 2) 参数规则匹配（按顺序，第一个命中）
rulePolicy = matchRules(entry?.rules, args)             # never | required | always | undefined

# 3) 危险默认规则（启发式兜底）
danger = matchDanger(args)                              # boolean

# 4) 合成最终判定
if rulePolicy == "never":      needApproval=false; recordable=false
elif rulePolicy == "always":   needApproval=true;  recordable=false
elif rulePolicy == "required": needApproval=true;  recordable=false   # 规则触发的审批不可一键记忆
else:                                                   # 无规则命中，看 permission
    needApproval = (perm == "needs_approval")
    recordable   = needApproval                        # 仅「纯 permission 触发」可记忆
if danger and rulePolicy != "never":                   # 危险升级；用户显式 never 可豁免
    needApproval = true
    recordable   = false                               # 危险项不可「总是允许」，每次必问

if not needApproval: return PASS
if not hasUI:        return BLOCK("需要审批但当前无界面（headless），已阻止")
return PROMPT(recordable, summarize(toolName, args))
```

**优先级**：`disabled` > 参数规则 > 危险默认规则升级 > 工具 `permission` > `defaultPermission`。用户显式 `never` 优先级高于危险默认规则（用户明确豁免）。

**危险默认规则（`matchDanger`，内置、不在文件里）**：尽力而为的启发式，扫描所有字符串型参数值，命中以下任一即视为危险：

- 命令片段：`rm -rf`、`sudo `、`mkfs`、`dd if=`、`:(){`（fork bomb）、`> /dev/`、`chmod -R 777 /`
- 敏感路径：`/etc/`、`/sys/`、`/proc/`，以及 `**/.ssh/**`、`**/*.pem`、`**/*.key`、`**/.env`

定位为「兜底」，不追求完备；精确控制靠用户配置的 per-tool `rules`。

## 8. 审批交互

钩子拿到 `PROMPT(recordable, summary)` 后调 `ctx.ui.select`：

- 标题：`MCP 工具调用审批\n\n  <server>: <tool>\n  参数：<summary>\n\n是否允许？`
- 选项：
  - `recordable == true` → `["允许本次", "总是允许", "拒绝"]`
  - `recordable == false`（`always` 或危险升级）→ `["允许本次", "拒绝"]`
- 结果处理：
  - 允许本次 → `PASS`，审计 `decision=approved`
  - 总是允许 → **原子写回**（写临时文件 + rename）将该工具 `permission` 置为 `auto`，**保留其既有 `rules`**（避免误删保护性规则），随后 `PASS`，审计 `decision=always-approved`。仅在 `recordable=true`（无规则命中、纯 `permission=needs_approval`）时出现此选项
  - 拒绝 → `BLOCK("用户拒绝执行")`，审计 `decision=rejected`

`disabled` 与 headless block 不弹窗，直接返回 `block` + 原因。

## 9. 默认值与运行细节

- 新连上、文件无记录的工具 → `defaultPermission`（`auto`）。
- 策略读取：进程内缓存 `{ mtimeMs, data }`，每次 `tool_call` 先 `stat` 比对 `mtimeMs`，变了才重读。前端（阶段 2）改文件后，sidecar 下次调用即感知。
- 写回并发：仅「总是允许」与阶段 2 前端会写；都用原子写（临时文件 + rename）。人工操作频率低，冲突概率可忽略；以最后写入为准。
- 与 server 启停的关系：server 在 `MCP_SERVERS_DISABLED` 里 → 工具根本不会注册，自然不触发本扩展；本扩展只在「server 已启用、工具已注册」的前提下做 tool 级管控。

## 10. 审计日志 `~/.pi/mcp-audit.jsonl`

每次 MCP 工具调用追加一行 JSON：

```json
{ "ts": "2026-06-15T05:00:00.000Z", "server": "github", "tool": "create_issue",
  "decision": "approved", "argsDigest": "{title:\"...\",...}", "durationMs": 412, "ok": true }
```

- `decision ∈ { auto, approved, always-approved, rejected, blocked-disabled, blocked-headless }`
- `argsDigest`：参数的紧凑摘要并截断到固定长度（如 500 字符），避免日志膨胀；可能含敏感参数（token 等），仅写本地用户目录，脱敏列为未来增强。
- 决策结果在钩子里记录；`durationMs` / `ok` 需要在工具实际执行后补写——见 §12 的接线方式。
- 默认开启，`audit.enabled=false` 关闭。失败（磁盘/权限）只 `console.error`，不影响工具调用。

## 11. 分阶段交付

- **阶段 1（纯 extension，零新 IPC）**：策略读取 + 三态 + 参数规则 + 危险默认规则 + 调用时审批（`ctx.ui.select`）+ 总是允许写回 + 审计。命令行 / headless 也生效，完整闭环。
- **阶段 2（前端权限面板）**：扩展页可视化每个已连工具的三态、编辑参数规则、查看审计日志。前端用 Tauri fs 读写同一策略文件（需在 `capabilities` 放行该用户级路径，少量配置，**非 RPC**）。

## 12. 代码落点与模块划分

新增 `extensions/mcp-policy/`：

- `policy.ts`（纯函数，无 I/O 之外的副作用，可单测）：
  - 类型：`Policy`、`ToolEntry`、`Rule`、`Decision`。
  - `parsePolicy(json) → Policy`（容错）。
  - `matchRules(rules, args)`、`matchDanger(args)`、`summarize(...)`、简单 glob `globMatch(pattern, value)`。
  - `decide(policy, toolName, args, hasUI) → Decision`。
- `index.ts`（接线，副作用集中于此）：
  - `loadPolicy()`：读 `~/.pi/mcp-policy.json` + mtime 缓存。
  - `writeAlwaysAllow(toolName)`：原子写回 `permission=auto`。
  - `appendAudit(record)`：追加 `~/.pi/mcp-audit.jsonl`。
  - `pi.on("tool_call")`：调 `decide` → 按结果 `ctx.ui.select` / 返回 `{ block, reason }` / 放行；记录审计。
- `package.json`：仿 `pi-mcp`，`pi.extensions = ["./index.ts"]`，devDeps `@earendil-works/pi-coding-agent`。
- 注册：把 `mcp-policy` 加入 `extensions/index.ts` 的 `allExtensions`，确保排在 `mcp` 之后/任意（钩子互独立）。

**关于 `durationMs` / `ok` 的补写**：`tool_call` 钩子在执行前触发，拿不到执行结果。MVP 采取「决策即记录」：钩子里先写一条 `decision` 审计（不含耗时/结果）。若需耗时与结果，作为阶段 1.5 增强——由 `extensions/mcp/` 在 `execute` 包装里补一条结果审计，或评估 Pi 是否提供 `tool_result` 钩子。本期审计以「决策」为主，结果审计标注为可选增强，避免跨扩展耦合。

阶段 2：`tauri-agent/src/features/extensions/`（权限面板组件）+ Tauri fs 读写 + `capabilities` 配置。

## 13. 测试策略

- `policy.ts` 单测（vitest，仿 `extensions/mcp/config.test.ts`）：
  - 三态决策：auto→PASS、disabled→BLOCK、needs_approval 有/无 UI。
  - 规则顺序匹配：第一个命中生效；never 豁免危险规则；always 不可记忆。
  - 危险默认规则：命中升级为需审批且 recordable=false。
  - 默认值：无记录走 defaultPermission。
  - `globMatch` 边界：`*` 通配、精确匹配、不匹配。
  - `summarize` / `argsDigest` 截断。
- 钩子集成测试：mock `ctx.ui.select` 返回三种选择 + `hasUI` 真假，断言 PASS/BLOCK/写回内容/审计行。

## 14. 风险与取舍

- **危险默认规则是启发式**：无法理解每个 MCP 工具的参数语义，可能漏判或误判；定位为兜底，主力是用户显式 `rules`。
- **disabled 调用时才 block**：模型会试调一次才知禁用，浪费一轮；换来「即时生效不重启」，可接受（disabled 使用频率低）。
- **跨进程读写同一文件**：阶段 2 前端与 sidecar 并发写，靠原子写 + mtime 重读兜底；人工操作频率低，冲突可忽略。
- **审计无结果/耗时（MVP）**：以决策审计为主，结果审计列为可选增强，避免跨扩展耦合。
- **全局而非 per-project**：同一工具在所有工作区共享授权；若未来需要项目级覆盖，可在策略文件加 `projects[cwd].tools` 叠加层（预留，不在本期）。
- **记忆范围有限（有意）**：「总是允许」仅对「无参数规则命中、纯 `permission=needs_approval`」的审批生效（设为 `auto` 且保留 rules）；规则触发（`required`/`always`）或危险升级的审批不可一键记忆，需到设置中改规则。这是为避免误删保护规则而做的取舍。
- **审计可能含敏感参数**：见 §10，`argsDigest` 可能包含 token 等敏感值，存本地用户目录，未来可加脱敏。

## 15. 验收标准

1. 新增 `extensions/mcp-policy/`，注册进 sidecar，不影响现有 `mcp` 连接与工具注册。
2. `permission=disabled` 的工具被调用时返回 block，不实际执行。
3. `permission=needs_approval`（或命中 `required` 规则）的工具调用时弹 `ctx.ui.select`，拒绝则 block，允许则执行。
4. 「总是允许」后，策略文件即时更新为该工具 `auto`，同会话内再次调用不再弹窗（无需重启）。
5. headless（`!hasUI`）下需审批的工具一律 block。
6. 参数级规则按顺序匹配，`never/required/always` 语义正确。
7. 危险默认规则命中时强制审批且不可「总是允许」。
8. 审计日志按配置写入，关闭后不写。
9. `policy.ts` 单测全绿；前端 / sidecar 构建通过。
10. 全程无 emoji，图标（阶段 2）走 `@lobehub/ui` 的 `Icon` + lucide。
