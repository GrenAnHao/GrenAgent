# Agent Note: 不再把 MCP 服务器清单注入对话，旧会话里的清单也不发给模型

Status: implemented

## Problem

MCP 扩展的 `before_agent_start` 每次发现服务器清单有变化，就返回一条 `display: false` 的自定义消息（`customType: "mcp-servers"`），内容是一行一个服务器，例如 `antd codemode`、`deepwiki codemode`。这个做法来自冻结的旧决定 `docs/decisions/extensions/2026-10-04-mcp-direct-server-wait.md`。

pi 把自定义消息转成 user 角色发给模型（`convertToLlm` 的 `case "custom"`），位置紧跟在用户自己的输入后面。模型看到的就像是用户在原文后面接着写了「antd codemode / deepwiki codemode」，于是把它当成要求去执行。实际出现过的情况：用户只发了一行 `// Note: 见 .agents/notes/...`，模型却先在 codemode 里把 antd 和 deepwiki 各调了一次，再回头读文件，最后的回答也围绕这两个服务器展开。pi 1.2 起 `before_agent_start` 对 triggerTurn 开的轮次也会触发，这条消息被插进去的机会更多了。

## Decision

- `extensions/mcp/index.ts` 的 `before_agent_start` 只保留等 direct 服务器（最多 10 秒）这一件事，不再返回消息，也不往系统提示里写任何服务器清单。`formatServerSummary`、`lastServerSummary` 以及直接调 `sessionManager.appendMessage` 的写入一并删除。
- 新增 `context` 钩子：发给模型的上下文里去掉旧版本写进会话的 `mcp-servers` 自定义消息，判断函数在 `extensions/mcp/legacyServersMessage.ts`。会话文件不改，只是不再发给模型。
- 模型照样能在需要时找到 MCP 工具：codemode 的工具描述里本来就列出了 codemode 服务器的工具声明；direct 工具作为普通工具声明；deferred 工具由 `tool_search` 查找。

## Alternatives considered

- **改用系统提示里的 `mcp_servers` 段（pi 内置 MCP 扩展的做法）**：放在系统提示里，不会再被读成用户输入；pi 也只在清单变化时追加系统补丁，对缓存友好。这版已经写好并测过，但没有采用。用户的判断是：只要清单出现在提示词里，模型就会把它当成比用户需求更高一级的东西，主动去调用。另外 codemode 的描述已经包含这些工具，单独再列一份清单没有带来新信息。
- **保留自定义消息，只把措辞改成「以下是可用服务器，不是请求」**：改动最小。不选：消息仍然以 user 角色紧跟在用户输入后面，措辞再明确也还是和用户的话混在一起，而且每次清单变化都要往会话里写一条。
- **只停止注入，旧会话里的 `mcp-servers` 消息不管**：不用加 `context` 钩子。不选：已有会话每一轮仍会把那段清单发给模型，在这些会话里问题不会消失。

## Consequences

- 收益：用户的一句话不会再被附加的服务器清单带偏；旧会话里残留的清单也不再发给模型。
- 代价：模型从系统提示里看不到 deferred 服务器的名字和一行描述，只能靠 `tool_search` 按关键词去找；codemode 服务器靠 codemode 描述里的工具声明，不受影响。
- 旧会话第一次去掉那条消息时，发给模型的前缀会变，这一轮前缀缓存失效一次。

## 验证

- 实跑：`cd extensions && npx vitest run mcp/legacyServersMessage.real.test.ts`。测试用真实 AgentSession，配两台 codemode 服务器，会话里预先写一条旧版的 `mcp-servers` 消息，用 faux 模型记录实际发出的请求。当前代码：通过，请求里只有用户原文，消息和系统提示里都没有 `antd codemode` / `deepwiki codemode` / `mcp_servers`。把 `extensions/mcp/index.ts` 换回 HEAD 版本再跑：失败，请求里带着 `antd codemode\ndeepwiki codemode`。证据：`.agents/evidence/2026-10-18-remove-mcp-server-list-injection/real-test.txt`。
- `npx vitest run mcp`：20 个文件、194 个用例全部通过，其中 `index.test.ts` 覆盖「before_agent_start 不返回消息、不写系统提示段」和「context 去掉旧清单、其他自定义消息保留」。
- `npx tsc -p electron-agent/tsconfig.node.json --noEmit`：仍是 156 条，去掉行号后没有新增。
