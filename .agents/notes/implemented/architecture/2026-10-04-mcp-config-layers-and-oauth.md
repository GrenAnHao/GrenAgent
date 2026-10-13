# Agent Note: MCP 配置三层合并带 exposure，OAuth 凭据按服务器名 + URL 分键

Status: implemented

## Problem

### MCP 配置按桌面、全局、项目三层合并，并带上 exposure

MCP 服务器同时来自回合快照 `PI_MCP_CONFIG`、桌面 `MCP_SERVERS`、`~/.pi/agent/mcp.json` 和项目 `.pi/mcp.json`。原先在读文件时就把同名项盖掉，并只认 command/url，项目里只写 `exposure` 或 `enabled: false` 的条目到不了连接列表。

### codemode 的 MCP 工具不进入激活集

合并后的 `autoEnableCodemode` 只存在于 `mergeMcpLayers` 的返回值里，管理器快照只留下服务器列表。工具注册则把每个已连接的 `mcp__*` 都放进激活集，模型和 codemode 脚本看到的是同一份名单。

### MCP OAuth 凭据按服务器名和 URL 分键，登录交给 SDK 的 auth

HTTP / SSE 的 MCP 服务器要走 OAuth。令牌必须按「服务器名 + URL」分开存，交换 code 之前要核对授权响应里的 `iss`，空的 `scope` 不能把登录打成失败。SDK 已经带了发现、PKCE、动态注册和 token 交换。

### MCP 资源工具与扩展登记的服务器共用同一个管理器

已连接的 MCP 服务器除了工具，还可能提供 resources 和 resource templates。扩展也能在运行时用 `pi.registerMcpServer()` 登记服务器。这两类入口如果各走一套连接，激活集、供应商 token 和 direct 等待会对不上。

## Decision

### MCP 配置按桌面、全局、项目三层合并，并带上 exposure

管理器读配置时先 `mergeMcpLayers`（桌面覆盖回合快照里的同名项，然后全局，然后项目），再走原来的 `injectDefaultServers` 和 `expandServerVars`。没有 command/url 的项目条目只补已有服务器的 `enabled`、`exposure`、`toolExposure`、`description`。`disabledMcpServers` 和 `enabled: false` 不连接。非法 exposure 跳过该服务器。`expandServerVars` 展开 `${ENV}`、整段 `!command`，以及 cwd 的 `~/` 和相对路径。

### codemode 的 MCP 工具不进入激活集

`project()` 用 `registerToolName` 登记工具，并带上解析后的 `exposure`、服务器 namespace 和 CallToolResult 形状的 `outputSchema`。激活集只加入 `direct` 工具；已不在本次连接里的 `mcp__*` 会去掉。快照里有 codemode 服务器且 `autoEnableCodemode !== false` 时保证 `codemode` 在列；服务器 exposure 或某个工具解析为 deferred 时保证 `tool_search` 在列。`callTool` 返回 SDK 原始结果，`execute` 再交给 `shapeMcpResult`。权限拒绝带 `isError: true`，不调用服务器。`autoEnableCodemode` 写在管理器快照上，默认读取路径在 `mergeMcpLayers` 之后保留该字段。

### MCP OAuth 凭据按服务器名和 URL 分键，登录交给 SDK 的 auth

纯规则放在 `oauthRules.ts`。连接时实现 SDK 的 `OAuthClientProvider`，由导出的 `auth` 完成登录。凭据写在 `~/.pi/agent/mcp-auth.json`，键是服务器名和 URL 的 JSON 数组。

交换 code 之前调用 `authorizationIssMatches`。不匹配则服务器状态为 `failed`，错误文本为 `授权服务器 iss 不匹配`，不把 authorization code 交给 `auth`。动态注册的客户端名缺省是 `GrenAgent`。

快照增加 `loginUrl`。系统浏览器打不开时把这个地址留在状态上，服务器不标成 `connected`。

### MCP 资源工具与扩展登记的服务器共用同一个管理器

`listTools` 成功后探测 `listResources` / `listResourceTemplates`。有至少一项资源或模板则快照 `hasResources` 为 true。探测失败只当没有资源，服务器仍保持 connected。有资源的服务器里只要有一台不是 `hidden`，就注册 `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`，exposure 取 direct、codemode、deferred 里最宽的一档；全是 hidden 不注册。`execute` 按工具名调用对应的 SDK 方法，结果交给 `shapeMcpResult`。

`session_start` 读取 `pi.getMcpServers()`，并订阅 `mcp_servers_change`。这些配置 `source` 为 `extension`，和文件合并结果放进同一个管理器。同名时保留文件那条，并记下「扩展登记的服务器被配置文件盖住」。只差 `-` / `_` 的名字用 `serverNamesConflict` 拒绝，不进入连接列表。扩展服务器从名单消失时断开连接，快照订阅会再次 `project()`。

### 涉及文件

- `extensions/mcp/merge.ts`
- `extensions/mcp/config.ts`
- `extensions/mcp/manager.ts`
- `extensions/mcp/index.ts`
- `extensions/mcp/oauthRules.ts`
- `extensions/mcp/transport.ts`

### 来源

- `docs/decisions/extensions/2026-10-04-mcp-layer-merge-exposure.md`
- `docs/decisions/extensions/2026-10-04-mcp-exposure-active-set.md`
- `docs/decisions/extensions/2026-10-04-mcp-oauth-credential-key.md`
- `docs/decisions/extensions/2026-10-04-mcp-resources-extension-servers.md`
- 04863224
- 410f56b2
- 9b55a180

## Alternatives considered

### MCP 配置按桌面、全局、项目三层合并，并带上 exposure

- 只合并三个文件层、丢掉 `PI_MCP_CONFIG`：回合中途 `setLiveWorkspaceMcpConfig` 和冻住的 ALS 快照会失效。
- 合并之后仍用旧的 overlay 把快照盖回去：文件里的禁用名单删不掉快照里的同名服务器。
- 让 `parseMcpServers` 直接返回没有 command/url 的条目：现有调用方会把它们当成可连接服务器。

### codemode 的 MCP 工具不进入激活集

- 继续把全部 `mcp__*` 放进激活集，只在描述里区分 exposure：模型仍会直接看到 codemode 工具。
- 在 `execute` 里把结果拼成 `{ text }` 再塑形：`isError` 和 `structuredContent` 到不了 `shapeMcpResult`。
- 让 direct 工具也顺带激活 `codemode`：没有 codemode 服务器时不需要这把钥匙。

### MCP OAuth 凭据按服务器名和 URL 分键，登录交给 SDK 的 auth

- 自己再写一套发现、PKCE、动态注册和 token HTTP：SDK 的 `auth` 已经串好这些步骤，平行实现会对不齐，也绕开它的 scope 选择。
- 凭据只按 URL 做键：同一 URL 的两台服务器会共用 token。规格要求各存各的。
- 浏览器打不开时仍标 `connected`，或丢掉登录地址：此时没有 access token，面板也没法把地址复制出去。
- 在扩展进程里调用 Electron `shell.openExternal`：MCP 管理器跑在 Pi worker，不是 Electron 主进程。打不开时改由操作系统打开 URL，失败则把地址留在状态上。

### MCP 资源工具与扩展登记的服务器共用同一个管理器

- 按服务器把资源登记成 `mcp__<server>__...`：模型和现有调用约定认的是这三个固定名字。
- 资源列举失败就把整台服务器标 failed：工具列表已经成功，模板或资源接口缺失不应该拆掉工具。
- 扩展登记覆盖同名的 mcp.json：文件是操作者显式写的配置，扩展插进来会改掉它。
- 把 `dev-radius` 和 `dev_radius` 当成两台服务器：sanitize 之后工具名会撞车。

## Consequences

### MCP 配置按桌面、全局、项目三层合并，并带上 exposure

`open-websearch` 的注入条件不变。`autoEnableCodemode` 已算出来，但本步不改变工具激活。项目配置出现在全局禁用名单里的名字仍然不连接。

### codemode 的 MCP 工具不进入激活集

注入的 `readServers` 不经过合并，快照上的 `autoEnableCodemode` 保持默认 true。未连接的服务器不参与这次激活判断。资源工具、登录和连接等待不在这一步。

### MCP OAuth 凭据按服务器名和 URL 分键，登录交给 SDK 的 auth

`auth.provider` 和扩展面板这次都没做。面板要显示登录，读管理器状态上的 `loginUrl`。`iss` 为空时规则放行，这是为了兼容不回 `iss` 的授权服务器；两边都有且不同则拒绝。未配置回调端口时，实际端口会记在同一条凭据里，避免下次登录换掉 redirect URI。

### MCP 资源工具与扩展登记的服务器共用同一个管理器

三个资源工具共用一个 exposure，不能按服务器各设一档。注入的 `readServers` 不会自动带上扩展登记，测试要走 `applyExtensionServers`。文件配置变化时仍会保留尚未被盖住、也没有名字冲突的扩展服务器。

## Verification

verify: n/a 回填的历史决定，源记录（docs/decisions）未记录验证
