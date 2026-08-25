# Mermaid 迁移与 UI 依赖升级设计

## 目标

解决聊天 Mermaid 图表无法可靠放大查看的问题，将聊天中的 Mermaid 渲染主体迁移到 `@lobehub/ui` 的 `Mermaid` 组件，同时保留项目已经提供的语法清洗、自动修复、AI 修复、修复结果持久化和复制导出能力。

## 范围

- 仅修改 `tauri-agent` 前端及其直接依赖。
- 依赖版本升级以最新兼容版本为目标；`motion` 的主版本升级单独验证，若造成回归则暂不升级。
- 不修改聊天消息协议、Mermaid 代码块解析规则或后端修复接口。
- 保留用户现有未提交改动，不将其混入本次提交。

## 方案

`LazyMarkdown` 继续负责把 Mermaid fenced block 从 Markdown 中分离。`Mermaid` 适配层继续接收当前的 `{ code, streaming }` 接口，但内部改为使用 `@lobehub/ui` 的 Mermaid/SyntaxMermaid 渲染和官方 SVG 预览机制。

渲染前仍执行 `sanitizeMermaidCode`，并优先使用 `mermaidFixStore` 中的修复代码。可确定修复的语法继续通过 `autoFixMermaid` 处理并写回 store。LobeHub 组件负责正常渲染、源码复制、折叠和点击放大；现有的 PNG、SVG、源码导出菜单通过 `actionsRender` 保留。渲染错误继续由适配层显示项目错误卡片，并提供 AI 修复入口。

LobeHub 组件当前基于 `beautiful-mermaid`，支持范围与 `mermaid` 包不同。因此回归测试覆盖 flowchart、sequence、state、class、er、xy，以及项目已有的 gantt、pie、mindmap、timeline 等样例；不支持的语法必须降级为错误卡片，不得导致整条消息白屏。

## 依赖升级

- 更新 `@lobehub/ui`、`@lobehub/editor`、`antd`、`mermaid`、`lucide-react`、`zustand` 等直接依赖并重新生成 `bun.lock`。
- 保持 React/React DOM 单实例 `overrides`。
- `motion` 从 12 到 13 的升级单独执行类型检查、构建和测试；若有跨组件 API 回归，保留 12.x 并记录原因。
- 不升级 Tauri、Rust 或非 UI 工具链依赖。

## 错误处理

- LobeHub Mermaid 的错误不传播到消息列表边界。
- 解析失败时显示现有错误卡片和源码。
- 有工作区上下文时继续允许 AI 修复；修复结果写入 `mermaidFixStore` 后重新渲染。
- 预览关闭、组件卸载时释放生成的 Blob URL，避免长期会话内存泄漏。

## 验证

1. Mermaid 适配层单测：代码清洗、修复缓存、错误降级、导出动作。
2. 组件测试：正常渲染、点击放大、关闭预览、折叠、复制和 AI 修复入口。
3. `bunx tsc --noEmit`。
4. 相关 Vitest 测试及完整 `bun run test`。
5. `bun run build`，并在桌面 WebView 中检查放大层、暗色主题和长图滚动。

