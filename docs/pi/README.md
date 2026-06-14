# Pi 仓库文档索引

> 来源仓库：`https://github.com/earendil-works/pi.git`  
> 本地路径：`pi/`  
> 整理基准：`main` / `9ccfcd7c`

这组文档面向需要快速理解、集成或二次开发 Pi 的工程师。它不是上游 README 的逐字搬运，而是把仓库中的 README、包配置、协议文档和关键类型整理成一条可阅读路径。

## 推荐阅读顺序

1. [扩展能力矩阵](./extension-capability-map.md)  
   按你的后续需求逐项映射到 Pi 的上游示例、Hook 和桌面端推荐落地方式。

2. [桌面端扩展操作手册](./extension-playbook.md)  
   面向沙箱、多智能体、MCP、plan mode、todo、权限、路径保护、上下文压缩、自动 git 等能力的操作步骤。

3. [仓库概览](./repository-overview.md)  
   了解 Pi 是什么、monorepo 包结构、运行模式和设计取舍。

4. [架构与数据流](./architecture.md)  
   了解从用户输入到 LLM、工具执行、事件流、会话落盘的主要链路。

5. [包说明](./packages.md)  
   逐个说明 `@earendil-works/pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui` 的职责和依赖关系。

6. [集成与 API](./integration-api.md)  
   面向 IDE、GUI、服务端或自动化系统集成，重点覆盖 SDK、RPC、扩展和会话格式。

7. [开发与维护](./development.md)  
   汇总本地开发命令、验证方式、配置、信任模型、安全边界和发布注意事项。

## 与现有文档的关系

- `docs/pi-agent-architecture.md`：偏向本项目 UI 集成场景，保留不覆盖。
- `pi/README.md`：上游仓库入口 README，适合查看官方介绍和链接。
- `pi/packages/*/README.md`：各包官方 README，适合查 API 细节。
- `pi/packages/coding-agent/docs/`：CLI、RPC、扩展、会话、设置等详细文档源。

## 快速结论

Pi 是一个 TypeScript monorepo，核心目标是提供一个“最小但高度可扩展”的编码代理 harness。它把 LLM provider 抽象、agent runtime、终端 coding agent、TUI 组件拆成独立包，并通过 extension、skill、prompt、theme、RPC 和 SDK 让外部系统扩展或嵌入它。

对于当前桌面端脚手架，优先不要 fork Pi core。沙箱、多智能体、plan mode、todo、权限控制、路径保护、自定义压缩、动态工具、上下文嫁接、自动 git、工具启停和结构化输出终止，都可以先通过 Pi extension 或桌面端 RPC/SDK 外壳实现。
