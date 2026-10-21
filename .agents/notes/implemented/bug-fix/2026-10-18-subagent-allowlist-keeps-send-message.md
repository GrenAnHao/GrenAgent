# Agent Note: 命名代理的工具白名单总是带上 send_message

Status: implemented

## Problem

scout / planner / reviewer / worker 这几个默认命名代理在 frontmatter 里写了 `tools:`（如 scout 是 `read, grep, find, ls, bash, code_explore`）。`openEmbeddedChildSession` 把它原样当成 SDK 的 `tools` 白名单，并在绑定扩展后用 `setActiveTools` 收窄活动工具。`send_message` 是 multi-agent 扩展注册的工具，不在任何一份白名单里，于是被 pi 的 `_isAllowedTool` 过滤掉，子代理看不到它。

可续聊的子代理在任务末尾收到 `continuableReturnGuidance`，要求「结束前用 send_message 把结果发给父代理」，但工具表里没有这个工具，模型只能回一句「我这里没有 send_message，本回复即为最终结果」。一次性子代理也失去了中途向父代理报告的通道。

同一处还有一个连带缺陷：带 `outputSchema` 时，SDK 的 `tools` 补了 `structured_output`，但 `setActiveTools` 用的是没补过的原始白名单，会把 `structured_output` 从活动工具里拿掉。

## Decision

子代理与父代理沟通的工具不受命名代理白名单约束。`embedded-runner.ts` 导出 `CHILD_ALWAYS_TOOLS = ["send_message"]` 和 `childToolAllowlist(tools, withStructured)`：白名单为空时返回 `undefined`（不限制，和以前一样）；非空时去空白、并上 `CHILD_ALWAYS_TOOLS`，有 `outputSchema` 再并上 `structured_output`。SDK 的 `tools` 和 `setActiveTools` 用同一份结果，两边不再不一致。

in-process 与 worker 两个后端都经 `openEmbeddedChildSession` 建会话（worker 进程里的 worker-host 也调它），一处改动覆盖两边。

只放行 `send_message`。`interrupt_agent` / `list_agents` / `wait_agent` 管的是自己派出的子代理；白名单里没有 `spawn_agent` 的命名代理派不出子代理，这几个工具对它没用，加进来只会撑大工具表。能力闸（`SAFETY_DENY_TOOLS`、`excludeTools`）照旧生效，`send_message` 不属于联网 / 写盘 / 代码执行任何一组，readonly 档不会挡它。

## Alternatives considered

- **在每个默认代理模板的 `tools:` 里写上 `send_message`** — 最强的理由：白名单仍是唯一真相源，读模板就知道代理有哪些工具。不用：用户已经种到 `~/.pi/agent/agents/*.md` 的旧模板不会更新，用户自写或仓库 `.pi/agents` 里的代理也会漏；与父代理沟通是子代理机制的一部分，不该靠每份定义各自记得。
- **有白名单时完全不收窄扩展工具，只收窄内置工具** — 最强的理由：一劳永逸，不用维护「必带」清单。不用：命名代理白名单本来就是用来藏 MCP、`spawn_agent` 等扩展工具的（`setActiveTools` 的注释写明了），放开会让 scout 拿到它不该有的工具。

## Consequences

所有子代理都能 `send_message` 给父代理，可续聊子代理的交付指引和工具表一致；带白名单的 `outputSchema` 子代理也不再丢 `structured_output`。代价是命名代理的白名单不再是工具表的完整清单，读模板的人要知道还有一个隐含的 `send_message`，这一点写在 `CHILD_ALWAYS_TOOLS` 的注释里。

冷恢复（`send_message` 唤起已卸载的子代理）不重放白名单，这次没有改动这条路径。

## 验证

- `cd extensions && npx vitest run multi-agent/`：新增「白名单带上 send_message 与 structured_output」「无白名单不限制」两条用例，原「setActiveTools 收窄」用例改为期望带上 `send_message`；embedded-runner 相关全部通过。`runner.test.ts` 的 3 条 `resolveSubagentModel` 失败在改动前（`git stash` 后单跑）就存在，来自本机设置里的 `SUBAGENT_MODEL`，与本改动无关。
- verify: n/a 实跑 — 当前宿主进程已加载旧的扩展模块，子代理工厂不会热重载；需重启 GrenAgent 后派一个 scout 看工具表里是否有 `send_message`。
