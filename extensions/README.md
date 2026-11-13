# Pi 扩展

GrenAgent 通过 Pi SDK 加载本目录的内置扩展。桌面会话的加载清单与独立 Pi Package 的入口不同。

## 桌面端加载哪些扩展

`agent-host` 创建会话时，从 [扩展工厂清单](./index.ts) 取候选，再按[会话 profile 和插件白名单](../cli/src/extension-profile.ts)过滤。下表是当前桌面端的内置扩展：

| 能力 | 常驻扩展 |
| --- | --- |
| 安全与权限 | `safety`、`approval`、`sandbox`、`mcp-policy` |
| 模型与上下文 | `header-placeholders`、`fast-mode`、`compaction-policy`、`image-limits`、`usage-ledger`、`session-memory` |
| 会话与提示词 | `loop-guard`、`rulebook`、`prompt-commands`、`context-rules`、`auto-title`、`todo`、`present`、`agent-mode`、`diagram-hint`、`fable-behavior` |
| 工作区与任务 | `jobs`、`multi-agent`、`working-directory`、`github`、`batch-tools` |
| 网络、资源与媒体 | `web-fetch`、`resource-manager`、`image-gen`、`tts`、`visual-companion` |

- **受插件状态控制**：[桌面端登记](../electron-agent/electron/app/plugin/builtinPlugins.ts)的 `goal`、`web-search`、`mcp`、`code-retrieval` 只有在状态为 `ready` 时才进入白名单。普通交互会话还由[运行时工厂](../cli/src/gren-runtime.ts)接入 SDK 的 Code Mode 与工具发现。
- **桌面端不加载的候选**：`lsp`、`dap`、`ast-tools`、`hashline`、`code-exec`、`debug-tools`、`diagnostics`、`after-tool-feedback` 仍在工厂清单，但不在当前桌面常驻集合，也未登记为桌面托管插件。
- **暂缓接入**：`im-gateway`、`im-platforms` 保留源码，不在产品加载清单。见 [IM 接回说明](../docs/im-reintroduction.md)。

### 代码检索与会话状态

`code-retrieval` 只注册 `code_explore`。工具经主进程的本地扩展端点查询 `codegraph-host`，与桌面「代码索引」使用同一份工作区索引。缺少索引时先在桌面端建立；查询不会自动创建索引。进程边界见[架构文档](../docs/architecture.md#代码索引)。

`session-memory` 保存会话压缩摘要与短期工作状态，作用域是当前会话。

## 在独立 Pi 中使用

[package.json](./package.json) 的 `pi.extensions` 只声明以下四个入口：

| 扩展 | 工具 | 配置 |
| --- | --- | --- |
| [网页抓取](./web-fetch/) | `fetch_url` | 无需模型或 API Key；支持 Markdown、纯文本、HTML、JSON 和 LLMS 输出 |
| [生图](./image-gen/) | `generate_image` | 配置 OpenAI 兼容的生图供应商 |
| [子代理](./multi-agent/) | `spawn_agent` 等 | 子会话使用可用的模型；支持单任务、并行和链式委派 |
| [语音合成](./tts/) | `speak` | 配置 OpenAI 兼容的语音供应商 |

单独调试可从仓库根目录运行 `pi -e ./extensions/web-fetch/index.ts`。其他扩展可能依赖 GrenAgent 的宿主能力；不要把整个目录复制到 Pi 的自动发现路径来模拟桌面加载。

## 开发与测试

从仓库根目录运行：

```sh
pnpm --dir extensions exec vitest run index.test.ts prompt-metadata.test.ts
pnpm --dir extensions exec vitest run code-retrieval/index.test.ts
```

扩展用 TypeScript 和 `typebox` 定义工具参数，通过 Pi 的 `registerTool`、`registerCommand` 或生命周期钩子接入。工具提示词字段与验收要求见 [AGENTS.md](../AGENTS.md#注册工具必须带官方提示词字段)。
