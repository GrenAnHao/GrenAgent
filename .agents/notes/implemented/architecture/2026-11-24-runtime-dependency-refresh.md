# Agent Note: 三个运行入口的依赖升级

Status: implemented

## Problem

CLI、扩展和 Electron 独立安装，桌面构建还会消费前两个入口的代码。只升级桌面清单会让同一工具在不同入口使用不同的 SDK。桌面编辑器也有一组不能逐项升到 latest 的 peer 依赖。

## Decision

- 延续 [Pi SDK 三入口锁定](../../implemented/architecture/2026-11-18-pi-sdk-1.5.2-upgrade.md)，同步升到正式版 1.6.0，维持现有安装补丁与供应链检查。各入口同时维护 pnpm 和 CI 使用的 npm 锁。
- 桌面内嵌 CodeGraph 由 1.6.2 升到 1.6.4，同步运行时版本标识；验证用临时项目。应用升级不重建用户的索引。
- LobeHub UI 5.64.3、editor 4.29.2、charts 5.7.2、icons 5.23.1 成组使用，保留 Lexical 0.42.0。5.50 起不再导出 `NeuralNetworkLoading`，工具卡改用 `@lobehub/ui/base-ui` 的 `<Spin variant="network" size={16} />` 保留网络动画。Ant Design、CodeMirror、MCP 和构建工具等更新到兼容版本；不迁移 Electron 38、React 19 或原生终端的版本线。
- CLI 和扩展直接使用 TypeBox 1.4.7；不覆盖 SDK 内部精确依赖的 1.3.27，也不收窄扩展对宿主的 peer 声明。桌面 npm、pnpm 锁均收录 CodeGraph 的六个平台包；macOS Intel 包使用实际提供 1.6.4 的官方 npm 源。

## Alternatives considered

- 所有包逐项升到 latest 可以缩短版本差距，但会混入 Electron 原生模块迁移，也不能保证编辑器 peer 组合可用。保留现有发布时间策略和构建白名单。
- 固定 LobeHub UI 5.49.1 可以保留旧导出，不改工具卡代码；新版 editor 和 charts 的 peer 要求更高。迁移到官方网络动画入口只需改一个组件，其他状态图标保持原样。

## Consequences

- 生产依赖许可证清单随桌面锁更新。DOMPurify 的两条引入路径都解析到 3.5.0，检查按实际分发版本读取双许可正文。
- [CodeGraph 1.6.4](https://github.com/colbymchenry/codegraph/releases/tag/v1.6.4) 的解析改进需要重建已有索引；升级不触碰现有项目索引。Electron 生产和本机启动产物分别更新，不代替实际安装包发布或 macOS 验收。

## 验证

- 三个入口的 `pnpm install --frozen-lockfile` 与 postinstall 通过，隔离目录的 `npm ci --dry-run --ignore-scripts` 均通过。未新增豁免，未变更根工具包和不参与安装的历史 Bun 锁。
- CLI 的 `pi-install-patches.test.ts` 11 项通过。扩展 SDK、MCP 与 schema 定向测试 12 项通过，工具元数据和 Fable 提示注入 5 项通过。
- Electron 的真实 SDK 会话、模型请求、差异卡和构建配置等 44 项通过，许可证 5 项通过；[CodeGraph 定向验证](2026-10-11-code-explore-single-tool.md) 213 项通过。
- CLI 与桌面 `npm run build`、桌面 `electron-vite build --mode localrun` 通过。只跑 `npm run ui:check -- tool-status-indicator composer-text file-explorer --rebuild`，三场景分别 8、25、230 项通过；覆盖网络动画正常停止、输入原文及草稿保留、文件树与编辑保存。
- 本机 Electron 38.8.6 分发目录缺少两个 Chromium 缩放资源和 `d3dcompiler_47.dll`。退出应用后，从与官方发行校验和一致的同版缓存 ZIP 只补回缺件；再次启动定向 UI 验证通过，未再出现资源加载错误。
