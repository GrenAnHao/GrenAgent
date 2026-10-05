# Pi Extensions Pack

一组受 [LobeHub](https://github.com/lobehub/lobe-chat) 启发、为 [Pi coding agent](https://github.com/earendil-works/pi) 补齐能力的扩展。每个都**自包含**(可单独用),也可作为**一个 Pi Package** 一次性安装全部。

## 包含的 extension

| 目录 | 工具 / 命令 | 需要 key? | 说明 |
|---|---|---|---|
| [`memory`](./memory) | `memory_search` `conversation_search` | Agent Data Runtime | 本地 L0-L3 长期记忆、会话捕获与自动召回 |
| [`web-fetch`](./web-fetch) | `fetch_url` | 否 | 网页抓取(SSRF 防护，`format` 选 markdown / text / html / json / llms) |
| [`image-gen`](./image-gen) | `generate_image` | 是 | 文生图(OpenAI 兼容) |
| [`multi-agent`](./multi-agent) | `spawn_agent` | 子 agent 需 | 委派隔离 pi 子进程(单个/并行) |
| [`fable-behavior`](./fable-behavior) | — | 否 | Fable 5 + coding-agent 行为层(Tier 注入 + 子 agent 种子) |
| [`tts`](./tts) | `speak` | 是 | 文字转语音(OpenAI 兼容) |
| [`im-gateway`](./im-gateway) / [`im-platforms`](./im-platforms) | — | — | **暂缓**：源码保留，未打进产品加载清单。接回见仓库根目录 `docs/im-reintroduction.md` |

合计 **当前桌面端打进主进程 / worker 的全部扩展**，长期记忆与知识检索由本地 `memory`、`wiki-rag` 与 `code-retrieval` 提供。

## 一键加载全部

```bash
# 方式 1:逐个 -e(开发调试)
pi -e ./extensions/memory/index.ts \
   -e ./extensions/web-fetch/index.ts \
   -e ./extensions/image-gen/index.ts \
   -e ./extensions/multi-agent/index.ts

# 方式 2:作为一个 Pi Package 安装(本目录已带聚合 package.json)
pi install git:github.com/<you>/<repo>     # 指向包含本 extensions/ 的仓库

# 方式 3:复制到自动发现目录
cp -r extensions/* ~/.pi/agent/extensions/
```

## 统一配置

桌面端由 Electron 托管本地 Agent Data Runtime；扩展通过受保护的 loopback endpoint 访问数据。其他需要外部服务的扩展仍按各自 README 配置。

## 技术共性

- TypeScript extension,`typebox` schema,`registerTool` / `registerCommand` / 生命周期钩子。
- `memory` 通过本地 Runtime 访问长期记忆与会话检索，并在 `before_agent_start` 注入相关上下文。
- `session-memory` 只管理会话短期工作状态，不承担长期知识存储。

## 测试

每个 extension 都有 jiti smoke 验证(累计 100+ 断言全过)。涉及真实 LLM 的回路(`spawn_agent` 实跑、真实 pi 端到端)需配 provider key 后体验。

## 注意

- 包名:按官方新名 `@earendil-works/*` + `typebox`(实测该 Pi 版本 bundle 的是 `typebox`,不是 `@sinclair/typebox`)。
- Agent Data Runtime 使用应用数据目录保存 Memory/Wiki 数据；扩展不直接管理 SQLite 文件。
