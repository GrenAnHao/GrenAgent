# 在自建 MCP 客户端上补齐官方 MCP 能力

- 日期：2026-10-04
- 状态：待审查
- 范围：`extensions/mcp`、会话扩展加载、扩展面板、以及为启用 `exposure` 必须做的 Pi SDK 1.0.2 升级
- 前提版本：仓库锁的是 `@earendil-works/pi-coding-agent@0.87.0`。官方 MCP 的 `exposure`、codemode、tool_search 从 0.99.0 起存在，当前 npm 最新是 1.0.2

## 1. 背景

桌面已经有自己的 MCP 客户端：`extensions/mcp` 用 `@modelcontextprotocol/sdk` 连接 stdio、旧式 SSE 和 Streamable HTTP，配置来自桌面 `MCP_SERVERS`、`~/.pi/agent/mcp.json` 和项目 `.pi/mcp.json`，连上后把全部工具注册成 `mcp__服务器__工具` 并放进模型的工具列表。权限在 `execute` 里走 Electron `mcp.call`，策略在 `extensions/mcp-policy`。

官方从 0.99.0 起把另一套 MCP 做成内置扩展。默认不把工具放进模型列表，由 codemode 脚本和 tool_search 去找、去调，并带有 OAuth、资源、结构化结果和供应商登录态。SDK 会话不会自动加载这套内置扩展。

本次在现有连接栈上补齐官方客户端的协议和行为。不加载 `createMcpExtension`。codemode 沙箱和 tool_search 使用官方扩展，因为这两样不是 MCP 连接器。

## 2. 目标与非目标

**目标**

1. 没写 `exposure` 的服务器按 `codemode`：工具可被脚本调用，不出现在模型的工具列表里。
2. 同时提供 `direct`、`deferred`、`hidden`，以及按工具名或模式覆盖。有 codemode 服务器时激活 `codemode`，有 deferred 服务器时激活 `tool_search`。`autoEnableCodemode: false` 时不激活 `codemode`。
3. 调用结果把 `isError`、`structuredContent` 和图片块交回去。模型看到截断后的文本，脚本拿到完整结果。
4. 服务器提供 resources 时注册 `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`。
5. HTTP 服务器支持 OAuth，以及用供应商当前登录 token 当 Bearer。
6. 别的扩展用 `pi.registerMcpServer()` 登记的服务器由本客户端连接。
7. 现有的权限、审计、探测缓存、热重连、SSE、`open-websearch` 注入和 `${workspaceFolder}` 保持可用。

**非目标**

- 不加载官方 `createMcpExtension`，不读取官方扩展自己的连接循环。
- 不做终端 `/mcp`，不做 `pi mcp` 子命令。登录放在扩展面板。
- 不做「登录 Radius 后自动写入 mcp.json」。
- 不给项目 `.pi/mcp.json` 再加一道官方 project trust。工作区打开后继续读这个文件。
- 不重写 QuickJS 沙箱，不重写 tool_search 的 BM25。
- 不在本次采纳虚拟模型、图片模型目录、分类器。SDK 升级只为把 `exposure` 和官方 codemode / tool_search 跑起来，并修掉升级必然碰到的宿主调用。
- `oauth.clientRegistration: "cimd"` 不使用 pi.dev 上 Pi 的客户端元数据文档。没有本应用自己的文档 URL 时，这种登录失败并在面板说明原因。

## 3. 边界

| 单元 | 职责 |
|---|---|
| `extensions/mcp` 管理器 | 连接、列工具、列资源、调用、热重连、超时、日志。不持有 Pi 会话对象 |
| `extensions/mcp` 扩展入口 | 把快照注册成带 `exposure` 的工具，处理 `registerMcpServer`，在 prompt 前等待该等的服务器，追加服务器摘要 |
| 官方 codemode、tool_search | 沙箱和延迟工具检索。通过 `ctx.executeTool()` 进入我们的 `execute` |
| `mcp-policy` 与 Electron `mcp.call` | 调用前的权限和审计。嵌套调用同样经过 `execute` |
| 扩展面板 | 展示连接状态、exposure、登录入口、可复制的登录地址 |

管理器需要供应商 token 时，只接收 `getProviderToken(providerId)` 回调。回调读取进程内共享的 `ModelRuntime`。后启动的会话不把这个回调换成另一份运行时。

## 4. SDK 升级（前提）

`electron-agent`、`cli`、`extensions` 三处把 `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-agent-core` 升到 1.0.2，锁文件里只保留一份 `pi-ai`。

升级时必须改的宿主调用：

- `electron-agent/electron/agent/workspaceHandle.ts` 和 `extensions/multi-agent/embedded-runner.ts` 的 `preflightResult` 改为接收 `"handled" | "queued" | "started"`。拒绝时回调不会被调用，外层用 `prompt()` 的完成情况判断拒绝，避免 Promise 挂住。两处对应测试一起改。
- `extensions/loop-guard` 和 `extensions/after-tool-feedback` 在替换 `tool_result` 的 `content` 时，把原有 `structuredContent` 一并返回。
- `cli` 的 `patch-pi-shell.mjs`、`patch-pi-edit-preview.mjs` 按 1.0.2 的 `dist` 重新对准；对不上就失败退出，不静默跳过。
- `extensions/multi-agent`、`extensions/agent-mode` 里从 `pi-agent-core` 引入的 `ThinkingLevel`、`AgentMessage` 若在 1.0.2 根入口消失，改从仍导出它们的包引入。
- `electron-agent/electron-builder.yml` 的 `asarUnpack` 加入 `@earendil-works/pi-codemode` 的 `dist/runtime/worker.js` 和 `quickjs-wasi/quickjs.wasm`。

升级会附带这些行为，本次不另做产品改动：模型上配置的 `samplingParams` 会合并进 `runtime.stream()` / `complete()`，`enhancePrompt` 已经传入的同名键仍以调用方为准；会话文件在第一条 user 消息时创建。

`makeGrenRuntimeFactory` 在 `PI_SYSTEM_WORKER=1` 时仍然传入空的扩展工厂列表。

## 5. 扩展怎么加载

桌面会话走 `cli/src/gren-runtime.ts`。在现有 `manifestExtensions` 工厂之外，加上 `createCodemodeExtension()` 和 `createToolSearchExtension()`。不加 `createMcpExtension`。

`cli/src/runtime.ts` 和 `cli/src/pi-worker.ts` 走 `main()`。1.0.2 的 `main()` 会加载内置 MCP。这两条路径在设置里加入 `-builtin:mcp`，关掉内置 MCP 客户端。codemode 和 tool_search 用 `main()` 已经加载的那一份，工厂列表里不再加一次。

自建 `extensions/mcp` 继续留在 `extensions/index.ts` 的清单里，负责连接和注册 `mcp__*` 工具。它不注册名为 `codemode` 或 `tool_search` 的工具，避免替换官方那两个扩展。

## 6. 配置合并

合并顺序，同名以后者为准：

1. 桌面 `MCP_SERVERS`
2. `~/.pi/agent/mcp.json` 的 `mcpServers`
3. 项目 `.pi/mcp.json` 的 `mcpServers`

然后：

- 出现在任一层 `disabledMcpServers` 里的名字删除。
- `enabled: false` 的条目不连接，配置仍保留。
- 项目条目如果没有 `command` 也没有 `url`，只覆盖已存在同名服务器的 `enabled`、`exposure`、`toolExposure`、`description`。找不到同名时记一条面板错误，不新建连接。
- 注入 `open-websearch`（现有规则：环境变量关闭或用户已有同名服务器时不注入）。
- 展开 `env`、`headers`、`command`、`args`、`url`、`cwd` 里的 `${workspaceFolder}`、`${cwd}`、`${ENV}`，以及占满整个值的 `!command`。
- `cwd` 里的 `~/` 展开到用户主目录。相对路径相对本次会话的工作目录。

`exposure` 缺省为 `codemode`。`codemode-deferred` 与 `codemode` 同义。`toolExposure` 的键是服务器原始工具名或带 `*` 的模式。精确名优先于模式，模式按书写顺序第一次命中为准。

合法的 exposure 只有 `codemode`、`deferred`、`direct`、`hidden`。其他值视为该服务器配置无效，跳过该服务器，其他服务器继续连接。

文件顶层 `autoEnableCodemode: false` 时，不因 codemode 服务器去激活 `codemode`。项目文件的该字段覆盖用户级。

写回 `mcp.json` 时保留不认识的字段，避免 `add_mcp_server` 或面板保存把 `oauth`、`auth`、`exposure` 抹掉。

传输仍按现有规则：有 `command` 走 stdio；URL 路径以 `/sse` 结尾走旧式 SSE；其余 http(s) URL 走 Streamable HTTP。官方会拒绝 SSE，本客户端继续接受。

## 7. 工具注册和命名

每个已连接工具注册为：

- 名字：`mcp__` + 服务器名 sanitized + `__` + 工具名 sanitized。sanitized 把非字母、数字、下划线换成 `_`。
- 超过 64 个字符，或同一服务器内 sanitized 之后撞名：截断并追加 `_` 加 `sha256(服务器名 + NUL + 原始工具名)` 的前 8 个十六进制字符，总长仍不超过 64。
- `exposure` 来自 `toolExposure`，否则来自服务器的 `exposure`。
- `namespace.name` 为 `mcp__` 加把服务器名里的 `-` 换成 `_`。`namespace.description` 用服务器的 `description`。
- `outputSchema` 描述一份 CallToolResult：`content`、`isError`、`structuredContent`。`structuredContent` 放完整结果。给模型的 `content` 文本按 UTF-8 超过 20480 字节时截掉中间，留下开头和结尾，中间写明截掉的字节数，全文路径写进结果。脚本通过 `structuredContent` 拿到未截断的内容。
- 空文本是空字符串。

只差 `-` 和 `_` 的两个服务器名视为同一个。后出现的拒绝连接，面板写明和谁冲突。

注册表保存「注册名 → 服务器名 + 原始工具名」。`callTool` 使用原始工具名。

`direct` 工具进入激活集。`codemode`、`deferred`、`hidden` 不进入激活集。`hidden` 使用 SDK 的 `exposure: "hidden"`：注册在册，激活无效，脚本也不能调用。

有一台 exposure 为 `codemode` 的服务器连上，且 `autoEnableCodemode` 不是 false 时，把工具名 `codemode` 放进激活集。有 `deferred` 服务器时，把 `tool_search` 放进激活集。

任一已连接服务器提供 resources 或 resource templates 时，注册三个资源工具。它们的 exposure 取这些服务器里最宽的一档，顺序是 `direct`，然后 `codemode`，然后 `deferred`。全是 `hidden` 时不注册。

服务器摘要（名字、exposure、一行 description）相对上一次发给模型的内容发生变化时，在下一条用户消息进入模型之前追加一条 `display: false` 的说明，一行一个服务器。摘要没变不追加。

## 8. 连接时机

`session_start` 按合并后的配置启动连接。

- 含 `direct` 工具的服务器：下一条要发给模型的 prompt 一起等待这些服务器，总上限 10 秒。超时后 prompt 照常发送，还没连上的转为后台，面板保持 connecting 或随后的失败原因。
- 不含 `direct` 工具的服务器：不阻塞 prompt，后台连接。
- 脚本或 `tool_search` 点名一个仍在连接的工具时，`execute` 等待该服务器本次连接结束。已经失败的服务器不再等待。连接失败则 `isError: true`，文本为失败原因，不向模型抛未捕获异常。
- 进度通知把该次调用的超时清零后重计。超时默认 60 秒，来自服务器的 `timeout`（秒）。

配置文件变化时仍按现有 diff 断开再连接变更项，然后重新注册工具并按第 7 节调整激活集。

恢复会话和 `/reload` 时，先开始重连，再让会话恢复已保存的激活工具名。deferred 工具名若此时还列不出来，先保留在激活集里，等工具列表到达后再 `registerTool`，不因为「当前未知」把这些名字删掉。

## 9. 一次调用

1. 模型调用 `codemode` 或 `tool_search`，或直接调用 exposure 为 `direct` 的工具。
2. 官方沙箱通过 `ctx.executeTool()` 进入我们的 `execute`。嵌套调用的 `toolCallId` 形如 `父id/序号`，并带 `parentToolCallId`。
3. `execute` 先做现有的 Electron `mcp.call` 授权。`mcp-policy` 的 `tool_call` 钩子继续按 `mcp__` 前缀生效。未允许时返回 `isError: true` 和现有拒绝文案，不连接服务器。
4. 按注册名反查原始工具名，调用管理器。
5. 返回给模型的是文本 `content`（超长则按第 7 节截断）。`structuredContent` 是完整 CallToolResult。MCP 的 `isError: true` 原样放在我们的结果上。图片块保留在 `content` 里。

工具卡片把带 `parentToolCallId` 的调用画在对应的 codemode 卡片下面，不另起一行顶层卡片。

## 10. 扩展登记的服务器

扩展在 `session_start` 读取 `pi.getMcpServers()`，并处理之后的 `mcp_servers_change`。这些服务器进入同一个管理器，来源标记为 `extension`。

同名时，第 6 节合并出来的文件配置优先，扩展登记被忽略，面板说明谁被盖住。扩展登记之间，以及和文件服务器之间，只差 `-` / `_` 的名字按第 7 节拒绝。

扩展登记的服务器可以带 `auth.provider`。卸载或 `unregisterMcpServer` 时断开该连接并卸下它的工具。

## 11. OAuth 和供应商 token

OAuth 只用于 HTTP / SSE 的 URL 服务器。配置字段：

| 字段 | 行为 |
|---|---|
| `clientId` | 有则当作已注册客户端。没有则动态注册 |
| `clientSecret` | 可使用第 6 节的变量展开 |
| `callbackPort` | 回调 `http://127.0.0.1:<port>/callback` |
| `callbackUrl` | 必须是 `localhost`、`127.0.0.1` 或 `[::1]` 上的 http URL，且没有 query 和 fragment |
| `scope` | 空格分隔 |
| `clientName` | 动态注册时的客户端名。缺省为 `GrenAgent` |
| `authServerMetadataUrl` | 有则跳过发现，直接用这份元数据。必须是 https，本机回环除外 |
| `clientRegistration` | `cimd` 时使用 `clientMetadataUrl`。`clientMetadataUrl` 为空则登录失败 |
| `clientMetadataUrl` | 本应用自己的 Client ID Metadata Document。不填 pi.dev 的地址 |

凭据存在 `~/.pi/agent/mcp-auth.json`，键是服务器名加 URL。同一 URL 的两台服务器各存各的。记录里保留 `access_token`、`refresh_token`、`expires_at`、`scope`。

登录由扩展面板的按钮发起。用 Electron 打开系统浏览器。打开失败时面板显示完整登录 URL，并提供复制。

令牌交换前检查授权响应的 `iss`。`iss` 指向另一台授权服务器时，在交换 code 之前拒绝。可选字段为空字符串或 `null`（含 `scope: ""`）时按缺失处理，不报 `Invalid scope`。服务器以 `insufficient_scope` 要求提升时，新的登录范围是已授予的 scope 加上还缺的 scope。

`auth` 只接受 `{ "provider": "<providerId>" }`。允许出现在全局 `mcp.json`、桌面 `MCP_SERVERS` 和扩展登记里。项目 `.pi/mcp.json` 里出现则该服务器配置无效并跳过。URL 必须是 https，或者 http 的主机是 `localhost`、`127.0.0.1`、`[::1]`。每次请求调用 `getProviderToken`。取不到 token 时该服务器失败，不匿名重试。

## 12. 日志和面板

连接与 OAuth 事件写入 `~/.pi/agent/mcp.log`。文件超过 5 MB 时改名为 `mcp.log.1`，新日志从空文件继续。只保留这一份备份。

面板每个服务器显示：状态（connecting / connected / failed / needs-login）、exposure、工具是否直接给模型、失败原因。needs-login 提供登录按钮。探测缓存继续保存注册全名。摘要推送仍走现有的 `mcp.state.publish`，字段在现有 `name`、`status`、`tools`、`toolNames` 上增加 `exposure` 和 `auth`（`none` / `oauth` / `provider`）。

单台服务器的配置错误、连接失败、登录失败不阻止其他服务器。

## 13. 测试

- 配置合并：三层覆盖、`disabledMcpServers`、`enabled: false`、项目级只改 exposure、无效 exposure 被跳过、`codemode-deferred` 等于 `codemode`、`autoEnableCodemode` 项目覆盖用户。
- 变量展开：`${ENV}`、整段 `!command`、`~/`、相对 `cwd`，作用于 `env` 和 `headers`。
- 命名：sanitized、64 字符截断、撞名哈希、`-` / `_` 服务器冲突。
- 注册：codemode 与 deferred 不进激活集；direct 进入；有对应服务器时激活 `codemode` 和 `tool_search`；`autoEnableCodemode: false` 不激活 `codemode`。
- 结果：MCP `isError` 传出；UTF-8 超过 20480 字节的模型文本被截断；`structuredContent` 仍是全文；权限拒绝不调用 `callTool`。
- 等待：不含 direct 工具的服务器不阻塞 prompt；多台 direct 服务器共用 10 秒上限，超时后 prompt 仍发出；点名仍在连接的工具会等待；已经失败的服务器立即 `isError`。
- OAuth：`iss` 不匹配时不交换 code；`scope: ""` 不失败；`insufficient_scope` 保留已有 scope；`cimd` 且没有 `clientMetadataUrl` 时失败。
- `auth.provider`：项目级配置被拒绝；非 https 且非回环被拒绝；每次调用都走 `getProviderToken`。
- 扩展登记：同名文件服务器优先；`mcp_servers_change` 后连上新服务器；注销后工具消失。
- 恢复：重连完成前列不出的 deferred 工具名仍留在激活集，列表到达后完成注册。

## 14. 实现顺序

1. 升到 Pi 1.0.2，并完成第 4 节的宿主修改。此时还不改变 MCP 的暴露方式。
2. 配置字段、命名、exposure 注册、结果形状、连接等待。
3. 在 gren-runtime 挂上官方 codemode 和 tool_search，并在 `main()` 路径关掉 `builtin:mcp`。工具卡片按 `parentToolCallId` 归组。
4. OAuth、`auth.provider`、面板登录。
5. 资源工具、扩展登记的服务器、日志轮转、恢复会话时保留 deferred 工具名。
