# Agent Note: MCP 与联网工具不再做已被下线的桌面预检

Status: implemented

## Problem

2026-11-07 的会话里，`mcp__gren_ssh__ssh_exec`、`mcp__antd__antd_list`、`mcp__assistant_ui__list_templates` 全部返回「MCP 调用已被 Electron 权限策略拒绝」，`web_search` 同样被拒。而 `agent-data.db` 的 `tool_audit` 里这几条都是 `decision=allow, resolution=auto`，`~/.pi/mcp-policy.json` 也把这些工具记成 `auto`：真正的门都放行了，是执行前另设的前置门拦的。

前置门是 `extensions/mcp` 与 `extensions/web-search` 里的 `authorizeDesktopOperation`，它往扩展端点发 `permission.authorize`。agentdata-host 子进程下线、改为进程内 `assembleAgentData` 之后，扩展的唯一可达通道换成 `MinimalExtensionEndpoint`，其 `ALLOWED_ENDPOINT_METHODS` 只保留 `codeRetrieval.call` / `permission.tool.*` / `system.*`，`permission.authorize` 明确返回 `METHOD_NOT_FOUND … is retired`。`desktop-control.ts` 把所有异常一律降成 `{ status: 'denied' }`，所以「方法已退役」被渲染成「用户拒绝」。

## Decision

工具审批只有一条链路：`extensions/safety` 的 `tool_call` 钩子向主进程发 `permission.tool.evaluate`（规则、内置护栏、审计），`extensions/mcp-policy` 再按 `auto / needs_approval / disabled` 拦 MCP 工具。MCP 工具的 `execute` 与联网工具的 `execute` 不再各自发 `permission.authorize` 预检：

- `extensions/mcp/index.ts` 的 MCP 工具与 `list_mcp_resources` / `read_mcp_resource` 直接调 manager；`project()` / `registerProjectedTools()` 不再接收 `control`，`McpToolDetails` 去掉 `error` 字段。
- `extensions/web-search/index.ts` 删除 `requireNetwork` 与工厂的 `control` 参数；`anysearch.ts` 的 `registerAnySearchTools` 删除 `guard` 参数与两处调用。
- `extensions/_shared/desktop-control.ts` 删除 `authorizeDesktopOperation`，它此前只有这两个消费者。

`DesktopControlPort` 仍保留，MCP 的 `mcp.state.publish` 与 safety 的 `permission.tool.*` 继续用它。`McpPolicyService.evaluateCall` 在主进程已无调用方，本次不动。

## Related notes

- [退役 AgentData 产品面与运行时](../simplification/2026-11-04-retire-agentdata-surface.md)：本次的直接前提。那篇把扩展端点收窄成 `codeRetrieval.call` + `permission.tool.*`，本篇修的是它留下的断口。那篇只写了「工具审批未执行」，没有覆盖到「扩展里的预检会因此永远拒绝」。
- [MCP 权限在模块挂载时独立读取](../bug-fix/2026-10-31-mcp-policy-initial-read.md)：部分重叠；`~/.pi/mcp-policy.json` 的读取与写入语义不变，本次不碰。
- [AgentData 运行在 agentdata-host 子进程](../architecture/2026-10-16-agentdata-host-process.md)：已被上述退役决策取代，其中「`permission.authorize` 经 `main.method` 回主进程」的路径已不存在。

未发现应被本次完整吸收或废弃的其他旧提案。

## Alternatives considered

- **把 `permission.authorize` 加回最小端点**（转发给 `permissions.authorize`，同步改掉 `minimalEndpoint.test.ts` 里那条「应报 retired」的断言）。改动最小、扩展一行不动，还能保留 `readonly` 档对 `mcp.call` 的 profile 级硬限；否决理由是这个方法刚被有意下线，加回去等于复活一个已经判定没有读者的入口，而且它和 `permission.tool.evaluate` 判的是同一件事的两半，双门正是假拒绝的来源。
- **只把 `denied` 改成放行、保留预检**：异常吞掉就放行会让真正的连接故障静默通过，等于把 fail-closed 改成 fail-open，比现状更糟。
- **让 `authorizeDesktopOperation` 在 `METHOD_NOT_FOUND` 时返回 allowed、其余异常仍 denied**：能修好这一处，但把「端点支持哪些方法」的知识塞进客户端，下一个被下线的方法会以同样的方式复发。

## Consequences

MCP 与联网工具不再出现「判定已 allow 却被执行前拒绝」的矛盾结果；`readonly` / `ask` 档对这些工具的约束改由 safety 的 `facts.flags`（`mcp: true` / `network: true`）与 `mcp-policy` 承担，两者行为一致的部分不变。

代价是失去 `PermissionManager` 的 `profile === 'readonly' → mcp.call / network.* 一律 deny` 这道与审批档并行的硬限。它此前几乎无效：`PI_PERMISSION_PROFILE` 由 `workerEnv` 写死为 `workspace`（仅 `__system__` 为 `automation`），会话里的审批档走的是 `APPROVAL_POLICY`，两者本来对不上。若日后重新需要 profile 级硬限，应该在 `permission.tool.evaluate` 的决策侧加，而不是在执行前另开一次 RPC。

主进程 `mainMethods['permission.authorize']` 与 `McpPolicyService.evaluateCall` 从此没有调用方。它们留在原地是因为 `AgentDataMainMethods` 的类型与运行时方法表把这个名字当作已登记的方法，移除会牵动 `assemble.ts`；如果确认没有外部端点消费者，可以随后一并删。

## Verification

- 改动前后各跑一次 `npx vitest run mcp web-search safety prompt-metadata.test.ts _shared/desktop-control.test.ts _shared/workspace-isolation.test.ts`：30 文件 330 项通过，日志 `.agents/evidence/2026-11-07-mcp-preflight-retired/vitest-green.log`。
- 全量 `npx vitest run`（extensions）：246 文件通过，3 项失败在 `multi-agent/runner.test.ts`、`sandbox/bashTool.test.ts`、`_shared/sandbox/windows/deleteSemantics.test.ts`；前两项在改动前 stash 复核时同样失败（环境相关），非本次引入。
- 定向类型检查 `npx --no-install tsc --noEmit -p tsconfig.node.json` 改动前后都是 207 条既有错误，逐行 diff 只有本次改动造成的行号位移，无新增诊断；日志 `.agents/evidence/2026-11-07-mcp-preflight-retired/tsc.log`。项目类型检查本身不绿，不能声称通过。
- 尚未在真机重启后验证 MCP 调用恢复（需重新打包并跑一次真实工具调用）。
