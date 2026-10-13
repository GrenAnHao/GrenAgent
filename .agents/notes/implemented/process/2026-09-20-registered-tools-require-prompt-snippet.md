# Agent Note: 注册工具必须带官方提示词字段（promptSnippet / promptGuidelines）

Status: implemented

## Problem

`pi.registerTool()` 的 `description` 只进工具 schema。自定义工具如果没有 `promptSnippet`，不会出现在默认系统提示词的 Available tools 里；此前做法是把工具清单抄进 Fable / 长系统提示词（08d2f62c 提交说明：「so custom tools show up in Available tools instead of being copied into Fable」）。

## Decision

所有自定义或覆盖的工具都按官方字段补齐，规则写在 AGENTS.md「注册工具必须带官方提示词字段」：

| 字段 | 本仓库要求 |
| --- | --- |
| `description` | 必填 |
| `promptSnippet` | 必填，一行摘要，写入 Available tools |
| `promptGuidelines` | 有路由或纪律时必填；每条必须写出工具名，禁止写 `this tool` |

- 统一用 `extensions/_shared/toolPrompt.ts` 的 `toolPrompt(snippet, guidelines)` 展开。
- 覆盖内置工具时 `promptSnippet` / `promptGuidelines` 不继承，要自己写。
- AgentData 一族只在主工具上写 guidelines（`code_explore` / `wiki_search` / `memory_search`）；动态 MCP 工具用 server 的 description 填 snippet，不在 Fable 里枚举 `mcp__*`。
- 懒加载工具加 snippet 会重建系统提示；纯发现 / 代理类工具可以只靠 `description`。

### 涉及文件

- `extensions/_shared/toolPrompt.ts`
- `extensions/prompt-metadata.test.ts`
- `AGENTS.md`

### 来源

- 08d2f62c
- AGENTS.md「注册工具必须带官方提示词字段」

## Alternatives considered

- **把工具清单抄进 Fable / 长系统提示词**：不依赖 Pi 的拼装机制，完全可控。不选：清单与实际激活工具脱节，Pi 已按当前激活工具自动拼 Available tools 与 Guidelines（AGENTS.md）。
- **每个工具都堆一条 guidelines**：最保险。不选：撑爆 Guidelines、反复重建系统提示前缀缓存（AGENTS.md）。

## Consequences

- 新增工具漏写 snippet 会被 `prompt-metadata.test.ts` 拦下。
- 动态激活带 snippet 的工具有缓存代价，需按上面的懒加载规则权衡。

## Verification

- `cd extensions && npx vitest run prompt-metadata.test.ts`：要求所有静态注册工具都有非空 `promptSnippet`，并检查 AgentData 工具的 guidelines 点了名（源记录未写结果）。
