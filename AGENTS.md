# AGENTS.md

本仓库的 Agent / 扩展约定。Pi 会从工作区向上查找并加载本文件。

## 注册工具必须带官方提示词字段

`pi.registerTool()` 的 `description` 只进工具 schema。自定义工具如果没有 `promptSnippet`，**不会**出现在默认系统提示词的 Available tools 里。后面新增或覆盖任何工具都要按官方字段补齐，不要只写 `description`，也不要把工具清单再抄进 Fable / 长系统提示词——Pi 会按当前激活工具自动拼 Available tools 与 Guidelines。

| 字段 | 作用 | 本仓库要求 |
| --- | --- | --- |
| `description` | 给模型看的工具说明与参数语义 | 必填 |
| `promptSnippet` | 一行摘要，写入 Available tools | 必填。没有这一行，自定义工具不会出现在该段 |
| `promptGuidelines` | 工具激活时追加到 Guidelines 的条目 | 有路由或纪律时必填；每条必须写出工具名，禁止写 `this tool` |

官方说明见 [pi.dev Extensions](https://pi.dev/docs/latest/extensions)：`promptGuidelines` 是扁平追加、没有工具名前缀，必须写成 `Use my_tool when...`。覆盖内置工具时，`promptSnippet` / `promptGuidelines` **不会**从原工具继承，覆盖定义里要自己写。

### 写法

```ts
import { toolPrompt } from "../_shared/toolPrompt.js";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "完整说明：做什么、关键参数、和相邻工具怎么分工。",
  ...toolPrompt("一行说明，供 Available tools 使用。", [
    "Use my_tool when ...; pass every relevant parameter from its schema.",
  ]),
  parameters: Type.Object({ /* ... */ }),
  async execute(_id, params, _signal, _update, ctx) {
    return { content: [{ type: "text", text: "done" }] };
  },
});
```

- `promptSnippet` 只写一行，不要复述整个 schema。
- `promptGuidelines` 只写模型不看字段就会用错的纪律。不要给每个工具都堆一条复述 snippet 的空话，以免撑爆 Guidelines、反复重建系统提示前缀缓存。
- AgentData 一族只在主工具上写 `promptGuidelines`（`code_explore` / `wiki_search` / `memory_search`），不要把同一段纪律复制到每个兄弟工具上。索引是否存在只由 `code-retrieval` 每轮 hint 说一次。Fable 默认只注行为核，不要把工具手册再抄回去。
- 动态投射的 MCP 工具用 server 给出的 description 填 `promptSnippet`；不要在 Fable 里枚举 `mcp__*` 名字。
- 懒加载、会话中途才激活的工具：加上 `promptSnippet` / `promptGuidelines` 会重建系统提示。需要进 Available tools 的产品工具仍然要写 snippet；纯发现/代理类工具可以只靠 `description`。

### 验收

新增或改工具后跑：

```bash
cd extensions
npx vitest run prompt-metadata.test.ts
```

该测试要求所有静态注册工具都有非空 `promptSnippet`，并检查 AgentData 工具的 guidelines 点了名。
