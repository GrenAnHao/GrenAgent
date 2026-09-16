# DAP 真调试器扩展 设计

- 日期：2026-06-17
- 状态：设计待评审（来自 oh-my-pi 借鉴评估，5 项之一；工作量最大）
- 主题：给 Pi 增加 `dap` 扩展：通过 Debug Adapter Protocol 驱动真实调试器（debugpy / delve / lldb-dap / js-debug），让模型能下断点、单步、看栈帧、读变量、求值。对标 omp 的 "Drives a real debugger"（28 dap ops，lldb/dlv/debugpy；"Most agents are still sprinkling print statements"）。

## 1. 背景与目标

### 现状
Pi 有 `debug-tools`（运行时日志收集器：插桩→复现→读回变量趋势，对标 Cursor Debug Mode）。它**无需断点**、适合"看运行时数据流"，但**不是真调试器**：不能断点暂停、单步、检查任意帧/作用域、表达式求值。

### omp 的做法
attach lldb 到 segfault 的 C 程序步进到坏指针；attach dlv 走 goroutine；debugpy 暂停/检查/求值卡住的 Python 进程。28 个 DAP 操作。

### 成功标准
1. 对 Python（debugpy）：`launch` 程序、设断点、`continue`/`step`、看 `stackTrace`/`scopes`/`variables`、`evaluate` 表达式。
2. 事件驱动：捕获 `stopped`(断点/异常)、`output`、`terminated`，把停驻点（文件:行、原因）回给模型。
3. `attach` 到已运行进程（二期）；多语言（Go/native，二期）。
4. 与 `debug-tools` 互补：日志看趋势，DAP 精确断点排查。

### 非目标
- 不做交互式 TUI 调试面板（一期面向 agent 工具；前端面板二期）。
- 不自带 adapter 二进制（探测 + 提示安装：`pip install debugpy` 等）。

## 2. 现状盘点
| 关注点 | 现状 |
|---|---|
| 调试 | `debug-tools`（日志注入，非 DAP） |
| 进程 | 扩展可 spawn adapter 常驻 + 双向 stdio |
| 协议经验 | 与 LSP 同为 `Content-Length` 帧 JSON-RPC（可共享帧编解码） |
| 状态 | DAP 是**有状态会话**（断点/线程/帧/作用域引用），需会话管理 |

## 3. 架构总览
```
extensions/dap/
  client.ts      DapClient：Content-Length 帧 + request/response/event（复用 lsp 的帧逻辑）
  adapters.ts    语言→adapter 命令（debugpy.adapter / dlv dap / lldb-dap / js-debug）+ 探测
  session.ts     DebugSession：launch/attach、断点表、当前线程/帧、停驻状态机
  events.ts      stopped/continued/output/terminated 事件 → 结构化回模型
  tools.ts       注册 dap_* 工具
  index.ts       装配 + 生命周期清理
```
DAP 与 LSP 都是 `Content-Length` JSON 帧 → **帧编解码与 LspClient 共享**（抽到 `_shared/jsonrpc-stdio.ts`）。

## 4. 工具接口（一期 Python）
```ts
dap_launch({ program, args?, cwd?, stopOnEntry?, language? })   → { sessionId, status }
dap_set_breakpoints({ path, lines: number[] })                  → { verified:[{line,verified}] }
dap_continue({ sessionId? })                                    → stoppedInfo | terminated
dap_step({ sessionId?, kind: 'over'|'into'|'out' })             → stoppedInfo
dap_stack_trace({ sessionId?, threadId? })                      → [{id,name,path,line}]
dap_scopes({ frameId })                                         → [{name,variablesReference}]
dap_variables({ variablesReference })                           → [{name,value,type,ref}]
dap_evaluate({ expression, frameId? })                          → { result, type }
dap_terminate({ sessionId? })                                   → { ok }
```
`stoppedInfo = { reason, threadId, frame:{path,line}, text? }`。

## 5. 会话与事件
- **状态机**：`initialize` → `launch/attach` → `setBreakpoints` → `configurationDone` → 运行 →（`stopped` 事件）→ 检查/步进 → `terminated`。
- **异步事件**：adapter 主动推 `stopped`(断点命中)/`output`(程序输出)/`terminated`。client 维护 pending 请求 + 事件订阅；`continue`/`step` 后**等待下一个 `stopped`/`terminated`** 再返回工具结果（带超时）。
- **引用语义**：`variablesReference`/`frameId` 是 adapter 给的句柄，工具透传，模型据此逐层展开。
- **多会话**：`Map<sessionId, DebugSession>`，按 cwd/请求隔离。

## 6. adapter 探测
| 语言 | adapter | 探测 |
|---|---|---|
| Python | `python -m debugpy.adapter` | `python -c "import debugpy"` |
| Go | `dlv dap` | `which dlv` |
| C/C++/Rust | `lldb-dap`(或 codelldb) | `which lldb-dap` |
| JS/TS | `js-debug`(vscode-js-debug DAP) | 路径探测 |
缺失 → 工具回"未找到 X 调试适配器，请安装 …"，不阻断其它工具。

## 7. pi 端改动
- 新扩展 `extensions/dap/`（`typebox`）；与 `extensions/lsp` 共享 `_shared/jsonrpc-stdio.ts`。
- `dap_*` 多为"执行/控制"语义 → **不进 Ask/Plan 只读白名单**；受 `safety`/项目信任约束（launch 等于跑程序）。
- 前端（二期）：调试面板（断点/调用栈/变量树/停驻位置），可挂到现有 dock。

## 8. 拆解（分阶段）
| 阶段 | 范围 | 依赖 |
|---|---|---|
| 1 | DapClient（共享帧）+ debugpy launch + breakpoints + continue/step + stack/scopes/variables/evaluate + 单测(帧/状态机) | （与 lsp 共享帧）|
| 2 | `attach` + Go(dlv) + native(lldb-dap) | 1 |
| 3 | 前端调试面板（断点/栈/变量） | 1 |
| 4 | 与 `debug-tools` 串联（日志定位热点 → DAP 精查） | 1 |

## 9. 关键决策
- **D1 共享 JSON-RPC stdio**：把 `Content-Length` 帧编解码抽到 `_shared/jsonrpc-stdio.ts`，lsp 与 dap 共用，降重复与体积。
- **D2 同步包装异步**：`continue`/`step` 等控制操作以"等下一个 stopped/terminated（带超时）"包装成同步工具返回，契合 agent 工具模型。
- **D3 先 Python**：debugpy 跨平台、无需编译，作为一期落点；native/go 二期。
- **D4 安全**：launch/attach 等同执行权限；只读模式禁用。

## 10. 风险与注意
- **复杂度最高**：有状态会话 + 异步事件 + 多 adapter 差异（capabilities 协商）——一期严格限定 debugpy 收敛风险。
- **挂起**：被调试程序不命中断点/等待输入 → 控制操作需超时与 `terminate` 兜底。
- **跨平台**：lldb-dap/js-debug 在 Windows 的可用性参差；一期 Python 优先。
- **资源清理**：调试子进程 + 被调试进程都要在 terminate/shutdown 时清理（进程树 kill）。
- **与 debug-tools 定位**：prompt 区分"无断点看趋势→debug-tools；断点精查→dap"。
