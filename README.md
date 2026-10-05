# GrenAgent

本地优先的桌面 AI 编码 Agent。基于 Pi 运行时（`@earendil-works/pi-coding-agent`），把对话、工具调用、代码智能、知识库与记忆整合进一个 Electron 桌面应用；默认使用本机托管运行时，也可连接远程 Gateway。

> **桌面端主线：Electron。** `electron-agent/` 是当前唯一维护的桌面实现；历史 Tauri 版（`tauri-agent/`，Tauri 2 + Rust）已于 2026-09-13 封存并从工作区移除，完整快照见 git 标签 `archive/tauri-agent`（`git checkout archive/tauri-agent -- tauri-agent` 可取回）。

<p align="center">
  <img src="images/hero-code-graph.jpg" alt="代码图谱 · 227 个文件 · 674 条依赖" width="100%">
</p>

## 特性

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="images/workspace-context.png" alt="多会话与项目管理" width="100%"><br>
      <strong>多会话与项目管理</strong><br>
      按项目分组的侧栏，支持置顶、重命名、右键菜单、在资源管理器中打开。
    </td>
    <td width="50%" valign="top">
      <img src="images/chat-diagram.png" alt="流式对话" width="100%"><br>
      <strong>流式对话</strong><br>
      工具卡片、Mermaid 渲染、Plan / Questions / Answer 卡片、子代理（Sub-Agent）内联视图。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="images/code-index.png" alt="代码智能" width="100%"><br>
      <strong>本地 CodeGraph</strong><br>
      由 MemoryKnowledge 统一提供符号检索、调用关系与影响分析，本机工作区自动登记并构建。
    </td>
    <td width="50%" valign="top">
      <img src="images/git-graph.png" alt="Git 集成" width="100%"><br>
      <strong>Git 集成</strong><br>
      改动 diff、分支切换、提交图谱，与 workspace 上下文一体。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="images/providers.png" alt="多供应商" width="100%"><br>
      <strong>多供应商</strong><br>
      多模型供应商配置与模型同步，生图、TTS、Embedding 等能力可分别选源。
    </td>
    <td width="50%" valign="top">
      <img src="images/mcp-servers.png" alt="MCP 扩展" width="100%"><br>
      <strong>MCP 扩展</strong><br>
      连接外部 MCP server，工具以 <code>mcp__&lt;server&gt;__&lt;tool&gt;</code> 暴露给 Agent，面板内测试连接与权限配置。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="images/skills.png" alt="本机 Skills" width="100%"><br>
      <strong>本机 Skills</strong><br>
      Skill 保持原生目录管理；Agent Data 模块与 Skill 生命周期解耦。
    </td>
    <td width="50%" valign="top"></td>
  </tr>
</table>

此外还支持：

- **本地 Wiki RAG** — Markdown 页面、来源引用和 FTS5 检索由本地 Runtime 管理。
- **本地长期记忆** — L0-L3 分层记忆由当前 Pi 模型提炼并按工作区隔离。
- **用量统计** — 按天、模型、项目聚合 Token 与费用。
- **终端 Dock** — 终端 tab 容器，子代理会话独立成 tab。
- **IM 接入** — 微信 ilink bot 与 HTTP 网关源码仍在仓库，当前稳定版不加载。接回见 [IM 功能：暂缓与后期接入](./docs/im-reintroduction.md)。

## 架构

GrenAgent 由以下部分组成：

| 模块 | 包名 | 职责 |
| --- | --- | --- |
| `cli/` | `grenagent-agent-sidecar` | 内嵌 SDK 装配与 `pi-worker` 入口。源码由 electron-vite 打进主进程 / worker，不再产出独立 `pi.exe`。 |
| `extensions/` | `pi-extensions-pack` | 内置扩展集合。由 `extensions/index.ts` 的 `allExtensions` 汇总，打进主进程与 worker。 |
| `electron-agent/` | `electron-agent` | **当前桌面应用**。React 19 + TypeScript + Vite 渲染层，Electron 主进程（内嵌 Pi SDK）与自研 Agent Data Runtime。 |
| `embedding/` | `embedding` | 独立本地向量服务（实验）。CPU 跑 `Xenova/all-MiniLM-L6-v2`，`POST /embed` 返回 384 维向量；尚未集成进主应用。 |

渲染层只通过 `window.gren` 与主进程通信（单业务通道 `gren:invoke` + `gren:event:` 事件广播），主进程内嵌 Pi SDK 跑交互 / Goal / 短调用；子代理 `spawn(process.execPath, [PI_WORKER_ENTRY])`。业务代码统一走 `src/platform/runtime.ts` 的后端抽象，不直接依赖 Electron。详见 [架构文档](./docs/architecture.md)。

## 快速开始

### 环境要求

- Node.js >= 22.19（`cli/package.json` 声明 `engines.node >= 22.19.0`）
- Bun（`electron-agent/` 的包管理，详见 [开发指南](./docs/development.md)）

### 启动桌面端

```bash
cd electron-agent
bun install
bun run dev
```

### 前端独立预览

```bash
cd electron-agent
bun run dev            # electron-vite 同时拉起主进程与渲染层
```

### 打包

```bash
cd electron-agent
bun run package        # electron-builder，产物在 release/
```

## 内置扩展

主进程与 `pi-worker` 通过 `extensions/index.ts` 的 `allExtensions` 编入内置扩展（`safety` 最先加载以尽早拦截）。扩展通过 `pi.registerTool()` 注册工具、`pi.registerCommand()` 注册斜杠命令；纯策略类扩展只挂 hook，无显式工具。

按职责大致分为：

| 类别 | 扩展 | 说明 |
| --- | --- | --- |
| 安全与策略 | `safety`、`approval`、`sandbox`、`loop-guard`、`rulebook`、`mcp-policy` | 工具拦截、审批策略、OS 沙箱、相同调用提醒、声明式规则、MCP 工具权限 |
| 会话管理 | `auto-title`、`compaction-policy`、`session-memory`、`goal`、`todo` | 自动标题、上下文压缩、会话状态、目标驱动、待办 |
| 模式与交互 | `agent-mode`、`diagram-hint` | Agent / Ask / Debug / Plan 模式；Mermaid / KaTeX 渲染提示 |
| 知识与记忆 | `memory`、`wiki-rag`、`session-memory` | 本地 L0-L3 记忆、Wiki 检索和当前会话压缩状态 |
| 联网与信息 | `web-fetch`、`web-search` | 单页抓取（`fetch_url`，用 `format` 选正文形式）；多引擎搜索（`web_search`） |
| MCP | `mcp` | 连接外部 MCP server，工具名 `mcp__<server>__<tool>` |
| 媒体生成 | `image-gen`、`tts` | 文生图（`generate_image`）；语音合成（`speak`） |
| 代码智能 | `code-retrieval`、`ast-tools`、`lsp`、`hashline`、`batch-tools`、`code-exec`、`debug-tools`、`dap`、`diagnostics` | CodeGraph 代码检索、AST 编辑、LSP、行号编辑、批量读写、执行、调试与诊断 |
| 多代理 | `multi-agent` | 子代理委派（`spawn_agent`） |
| 外部集成 | `github` | GitHub CLI 封装（`github`） |
| IM 接入（暂缓） | `im-gateway`、`im-platforms` | 源码保留，不进 `allExtensions`。接回见 [IM 功能：暂缓与后期接入](./docs/im-reintroduction.md) |

完整清单与工具名见 [架构文档 — 内置扩展](./docs/architecture.md#内置扩展)。

## 文档

- [架构文档](./docs/architecture.md)
- [开发指南](./docs/development.md)

## 目录结构

```
.
├── cli/             # 内嵌 SDK 装配与 pi-worker 入口
├── extensions/      # 内置扩展集合，由 extensions/index.ts 的 allExtensions 打进主进程 / worker
├── electron-agent/  # 桌面应用（electron-agent），当前主线
│   ├── src/         # React 渲染层：features / stores / lib / platform / components / theme
│   └── electron/    # Electron 主进程：app / agent / agentData / pi，及 ipc 与 preload
├── embedding/       # 独立本地向量服务（实验，未集成进主应用）
└── docs/            # 架构与开发文档；superpowers/ 为现行规格与计划，6–8 月已落地文稿在 superpowers/archive/
```

## 许可证

本项目采用 MIT 协议。

## 友情链接

- [LINUX DO](https://linux.do/) — 新的理想型社区

## 命名说明

产品名为 GrenAgent。底层 Agent 运行时为 Pi（`pi-coding-agent`），由 Electron 主进程内嵌。内部 CSS 设计变量 `--gren-*` 与若干 localStorage 持久化键属于实现细节，不对外作为品牌。
