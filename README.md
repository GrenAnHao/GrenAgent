# GrenAgent

GrenAgent 是基于 Pi SDK 的桌面 AI 编码工具。打开一个本地项目，就能在同一个工作台里对话、改代码、审查改动和运行命令。会话、用量账本和代码索引保存在本机；使用远程模型时，请求会发给你配置的供应商。

## 快速开始

建议使用 Node.js 24 和 pnpm 12.6.0，与 macOS 构建流程一致。桌面端主要在 Windows 上开发和验证；仓库也提供 macOS DMG 和 Linux AppImage 打包配置。

在仓库根目录安装依赖。三个子项目各有自己的锁文件；根目录的依赖用于校验决策笔记。

```sh
pnpm install --frozen-lockfile
pnpm --dir extensions install --frozen-lockfile
pnpm --dir cli install --frozen-lockfile
pnpm --dir electron-agent install --frozen-lockfile
pnpm --dir electron-agent start
```

第一次打开后，到「设置 → 供应商」配置模型并测活，再回到「对话」打开项目。

- **改界面**：用 `pnpm --dir electron-agent dev` 启动 Vite 热更新。Windows 开发服务优先使用 IPv4 回环，页面仍走 `localhost:31415`。
- **日常运行**：`start` 先构建再启动，渲染层直接从本地文件加载，不依赖 Vite 开发服务。已有可用构建时可运行 `pnpm --dir electron-agent start --skipBuild`。

## 工作台

- **项目与会话**：按项目组织对话，支持置顶、归档、会话内查找和后台状态提醒。工具调用、文件差异和子代理的执行过程可在对话里查看。
- **编码与长任务**：Agent、Ask、Debug、Plan、Ultra 五种模式。运行命令受会话权限与沙箱控制；后台命令可跟踪输出、单独停止。Goal 按会话里的完成条件续跑；子代理可以并行处理独立任务。
- **代码索引与 Dock**：在「代码索引」为项目建立 CodeGraph 索引，搜索符号、查看调用关系并跳到源码。Agent 使用同一套索引能力。终端、文件管理器和内置浏览器可以停靠在工作台内。
- **模型与扩展**：管理内置和自定义供应商模型，按模型设置思考档位、Fast 和上下文预算。扩展工作台管理 MCP、技能、命令和规则。用量页区分供应商报告、本地估算和未知来源，缓存预热单独统计。

旧 Repo Wiki 和知识库已从当前工作台移除，代码检索入口是「代码索引」。微信和 HTTP 网关源码仍保留，当前不加载。早期 Tauri 版见 Git 标签 `archive/tauri-agent`。

## 开发与打包

在仓库根目录执行：

| 用途 | 命令 |
| --- | --- |
| 跑指定桌面测试 | `pnpm --dir electron-agent exec vitest run <测试文件>` |
| 验证指定 UI 场景 | `pnpm --dir electron-agent ui:check <场景名>` |
| 检查主进程与宿主类型，不生成文件 | `pnpm --dir electron-agent exec tsc -p tsconfig.node.json --noEmit` |
| 跑 CLI 测试 | `pnpm --dir cli test` |
| 校验决策笔记 | `pnpm run verify-notes` |

用真实 Electron 窗口验证交互时，按 [AGENTS.md](./AGENTS.md) 选择对应的 UI 场景。只做类型检查时保留 `--noEmit`；如果需要输出 JS 和声明文件，给 TypeScript 指定独立的 `outDir`，不要生成到源码旁边。

打包先构建，再生成安装文件；以下命令不会发布：

```sh
pnpm --dir electron-agent build
pnpm --dir electron-agent package --publish never
```

`dev` 和 `start` 的主进程产物在 `electron-agent/out/`；`start` 从 `electron-agent/dist/` 加载界面。打包读取 `electron-agent/out-pkg/`，安装文件写入 `electron-agent/release/`。

## 代码在哪里

| 目录 | 职责 |
| --- | --- |
| [`electron-agent/`](./electron-agent/) | React 工作台、Electron 主进程、进程间通信、CodeGraph 和 UI harness |
| [`cli/`](./cli/) | Pi SDK 装配、CLI 与 worker 入口 |
| [`extensions/`](./extensions/) | 内置工具和扩展，实际加载集合由运行时配置决定 |
| [`.agents/notes/`](./.agents/notes/) | 决策笔记、取舍与验证入口 |

渲染层通过 `window.gren` 调用 Electron 主进程。交互会话、扩展和后台任务运行在 `agent-host`，索引由独立的 `codegraph-host` 承载。维护 SDK 集成时参见 [Pi SDK 升级清单](./docs/pi-sdk-upgrade-checklist.md)。

## 许可证

采用 [PolyForm Noncommercial License 1.0.0](./LICENSE)。商业使用需另行获得书面授权，见[授权说明](./COMMERCIAL.md)；依赖和参考实现见[第三方声明](./docs/third-party-notices.md)。
