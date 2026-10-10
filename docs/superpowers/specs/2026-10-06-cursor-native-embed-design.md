# 在 Pi 进程内接入 Cursor

把 omp 相对原生 Pi 多出来的 Cursor 客户端放进本仓库。GrenAgent 直接说 Cursor 的 agent 协议。性能标准是 omp 自己用 Cursor 时的那条路径：一轮用户消息一次 AgentRun，工具在同一条 HTTP/2 流里执行并写回，到 Cursor 的直连按源站复用。

官方 `@earendil-works/pi-ai` 继续负责其它供应商。运行时不依赖 omp 的源码目录，也不把 `pi-ai` 整包换成 omp 的。

## 放置

Cursor 传输、protobuf、OAuth、HTTP/2 会话池放在 `cli/src/cursor/`。sidecar 启动时用 `registerApiProvider` 把它注册成 `cursor-agent`。Electron 仍通过 `cli/src/pi-sdk.ts` 调用原来的 `streamSimple`。

渲染进程只加三件事：Cursor 登录入口、模型列表、思考档位。开流和工具执行留在已经跑 Agent 循环的进程里。

agent 循环的差量打在已安装的 `@earendil-works/pi-agent-core` 的 `dist` 上，用 `cli/package.json` 里已有的 postinstall 脚本，和 `patch-pi-shell.mjs`、`patch-pi-edit-preview.mjs` 并列。脚本先改 `cli/node_modules/@earendil-works/pi-agent-core/dist`。extensions 若解析到另一份 `pi-agent-core`，同一脚本把同样的改动打到那份 `dist`。文件里已经有 `kCursorExecResolved` 就跳过。补丁只做两件事：

- Agent 接受 `cursorExecHandlers`，每次 `streamFn` 都把它放进选项。
- 助手消息里带 `kCursorExecResolved` 的 `toolCall` 不再本地执行。供应商已经写回的工具结果留在会话里，和这次调用成对。标记与 omp 的 `kCursorExecResolved` 是同一个符号，供应商和补丁都用它。

会话创建处（现有 `createAgentSessionRuntime` 路径）用当前 `toolRegistry` 组装 `CursorExecHandlers`，传入 Agent。cwd、权限和工具事件走现有工具，不另做一套执行器。

## 请求路径

用户发一条消息时：

1. 模型 `api` 为 `cursor-agent` 时，`streamSimple` 进入 `cli/src/cursor/`。
2. 直连按源站复用已有 HTTP/2 会话，这一轮只新开请求流。一轮结束只关请求流。经代理隧道的连接不进池，用完即关。
3. 云端在流里要求执行工具时，handler 调用会话里已有的工具，结果写回同一条流，模型继续生成。
4. 这些调用在助手消息上带 `kCursorExecResolved`。循环看到标记就跳过，避免同一条 `bash` / `read` / `grep` / `write` 再跑一次。
5. 下一条用户消息整段重放历史。`resume` 只用于这一轮流中途的重试，不用于下一条用户消息。

中间不经过 OpenAI Responses，也不经过本仓库之外的反代。

模型 id 和思考档位的线上映射从 omp 的 Cursor 目录规则原样搬来，放在 `cli/src/cursor/` 解析它们所需的最小代码里。TypeScript 里不按模型名写分支。

## 思考档位

界面上的档位先夹到该模型在目录规则里的阶梯，再按 omp 的 `effortRouting` 换成线上 id。调用方显式给出的档位覆盖 id 后缀里的档位。关闭思考时设置 `disableReasoning`，请求里不带 effort。

Cursor 模型在模型表里带这套阶梯。界面不用 `openai-responses` 的 minimal / low / medium / high 兜底去收窄它。

## 登录

没有可用访问令牌时走 Cursor OAuth（PKCE，登录页 `https://cursor.com/loginDeepControl`，轮询 `https://api2.cursor.sh/auth/poll`）。访问令牌还有效就直接用。`isCursorTokenExpiringSoon` 为真时先用 refresh token 换新的，成功后再发请求。该判断与 omp 相同：默认阈值 300 秒，JWT 解析失败视为即将过期。刷新失败则重新登录，并且不发出这次上游请求。

Windows 上打开登录页时把完整 URL 交给系统（`rundll32 url.dll,FileProtocolHandler`）。不用 `cmd /c start`，避免查询串在 `&` 处被拆开。

令牌存在 sidecar 的应用数据目录，文件名为 `cursor-credentials.json`。不写入 `~/.omp/cursor-proxy-credentials.json`。日志和错误字符串里不出现令牌。

## 失败

- 本地目录里没有的模型：开流之前失败，错误走 Agent 现有的本轮失败路径。
- HTTP/2 会话出错或收到 `GOAWAY`：从池里丢掉，下一轮重新连接。Cursor 在流中途报告模型不存在时的回退，以及流中途检查点重试，只关掉这一轮的请求流，池里的连接留着。
- 用户中止：取消这一轮的请求流，循环停住，不补一轮。
- 工具在流里执行失败：错误作为这次工具调用的结果写回同一条流，并标上 `kCursorExecResolved`。循环不再执行一次。
- 没有对应 handler 的内置 exec：仍回一条成对的失败结果，避免助手消息缺结果、下一轮重放时被整段丢掉。

## 测试

测试锁住调用方看得到的行为：

- 同一源站连续两轮直连，第二轮复用已有 HTTP/2 会话，只新开请求流。会话出错或 `GOAWAY` 之后，下一轮重新连接。
- 流里执行过的 `bash`、`read`、`grep`、`write` 回到循环时带 `kCursorExecResolved`，循环不再调用。工具抛错时，流上有一条成对的失败结果，会话里调用和结果成对。
- 思考档位先夹到模型阶梯再换成线上 id。显式档位覆盖 id 后缀。关闭思考时请求不带 effort。
- 未知模型在开流之前失败。用户中止会取消这一轮请求流，并且没有第二轮请求。
- 令牌有效时直接使用。`isCursorTokenExpiringSoon` 为真时先刷新再请求。刷新失败时走登录，且没有上游请求。打开登录页的 URL 同时带有 `challenge` 和 `uuid`。
- `cursor-agent` 走到 `cli/src/cursor/`。`openai-responses` 和 `anthropic-messages` 仍走 `@earendil-works/pi-ai`，请求体里没有 Cursor 字段。

## 范围外

- 不改 Responses 反代，这条路径也不调用它。
- 不替换 `@earendil-works/pi-ai`，不改其它供应商的请求形状。
- 不把客户端改写成 Rust。
- 不承诺 Cursor IDE 的首字时间或出字速度。对齐的是 omp 进程内这条路径，包含下一条用户消息整段重放历史。
