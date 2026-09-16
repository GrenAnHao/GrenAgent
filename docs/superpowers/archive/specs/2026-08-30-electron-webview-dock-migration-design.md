# Electron `<webview>` 右侧 Dock 迁移设计

## 1. 背景与目标

当前产品使用 Tauri，前端位于 `tauri-agent/src`，后端能力由 Rust command、Pi sidecar 和 TencentDB 本地运行时提供。本次迁移新建独立的 `electron-agent` 工程，保留 `tauri-agent` 不变。

目标如下：

- 使用 Electron 构建新的桌面工程。
- 迁移当前 Tauri 前端的可复用 React、Vite、主题、状态和 Dock 资源。
- 在右侧 Dock 中实现 Codex 风格的内置浏览器。
- 浏览器内容使用 Electron `<webview>` 标签。
- 让 Dock TabStrip、浏览器标签栏、地址栏和菜单与 `<webview>` 视觉上一体，但网页内容不得覆盖这些 DOM 控件。
- 将当前 Rust/Tauri 后端能力用 TypeScript/Node 重写。
- 将 Pi、TencentDB Core、Knowledge、Panel 和所需 Node 运行时随 Electron 应用发布。
- 完成 Electron Main、preload、Renderer、Pi 和 TencentDB 的对接。

## 2. 范围与非目标

### 范围内

- 新建根目录下的 `electron-agent`。
- 评估并拷贝 `tauri-agent/src` 中可复用的前端代码。
- 替换前端中的 Tauri API 依赖。
- 实现右侧 Dock 浏览器和浏览器标签管理。
- 实现 `<webview>` 生命周期、导航、状态、错误和安全控制。
- 用 TypeScript/Node 重写当前 Rust command 的等价能力。
- 复用现有 Pi sidecar 和 TencentDB 构建产物流程，并迁移启动与监督逻辑。
- 为 Electron 版本增加单元测试、集成测试和打包冒烟测试。

### 非目标

- 不修改 `tauri-agent` 的源代码、配置、依赖和构建结果。
- 不把 VS Code 扩展生态、Extension Host 或 Marketplace 纳入本次迁移。
- 不直接复制 VS Code Workbench 或其内部 Webview 实现。
- 不把远程网页的 DOM 与 Electron Renderer 的 DOM 合并到同一个上下文。
- 不在第一阶段迁移与右 Dock 无关的视觉重构。

## 3. 现有项目基线

右侧 Dock 当前调用链为：

```text
App.tsx
└─ RightPanelColumn
   └─ RightPanelShell
      └─ DockPanel(region="right")
         ├─ TabStrip
         └─ TabBodyStack
```

`RightPanelShell` 已有右面板宽度和自适应逻辑，默认范围为 200–800 px。`DockPanel` 已支持 `page`、`projectContext`、`subagent` 等 Tab 类型。`page` 当前用于展示抓取后的内容，不等同于可持续导航的浏览器页面。

前端中的 Tauri 依赖主要集中在以下能力：

| Tauri 依赖 | Electron 迁移目标 |
| --- | --- |
| `@tauri-apps/api/core` | `ipcMain.handle` + preload 类型化 API |
| `@tauri-apps/api/event` | `webContents.send` + Renderer 订阅 |
| `@tauri-apps/api/window` | `BrowserWindow` API |
| `@tauri-apps/api/webview` | `<webview>` 事件和 Electron 主进程控制 |
| `tauri-plugin-dialog` | Electron dialog |
| `tauri-plugin-opener` | `shell.openPath`、`shell.openExternal` |
| Tauri 文件、终端、Pi、TencentDB 封装 | TypeScript/Node Main 服务 |

现有运行时构建已经固定了 Pi sidecar、TencentDB 上游 commit、Node 版本、SHA-256 和 manifest 校验。这些供应链校验规则在新工程中继续保留。

## 4. 工程结构

新工程与原项目并列：

```text
Pi/
├─ tauri-agent/                 原项目，保持不变
└─ electron-agent/              新项目
   ├─ electron/
   │  ├─ main.ts                Electron 主进程入口
   │  ├─ preload.ts             安全桥接入口
   │  ├─ ipc/                   类型化 IPC command registry
   │  ├─ browser/               浏览器 Tab 和 WebView 管理
   │  └─ runtime/               Pi、TencentDB、进程监督
   ├─ src/                      从 tauri-agent 迁移的 React 前端
   ├─ scripts/                  Electron 构建和资源准备脚本
   ├─ resources/                打包时使用的运行时资源
   └─ package.json
```

前端迁移采用拷贝快照方式，先保证两个工程独立。只有当 Electron 版本稳定后，才考虑提取共享包；本次不要求同时重构两个工程。

## 5. 右侧 Dock 浏览器设计

### 5.1 组件层级

```text
RightPanelShell
└─ DockPanel(region="right")
   └─ BrowserPanel（新增 DockTabKind: browser）
      ├─ Dock TabStrip（React DOM）
      ├─ Browser TabStrip（React DOM）
      ├─ Browser Toolbar（React DOM）
      └─ BrowserContent
         └─ <webview>
```

浏览器作为现有右 Dock 中的一类面板，浏览器内部再管理网页标签。当前 `page` Tab 保留，继续展示静态抓取结果。

### 5.2 DOM 与 `<webview>` 布局

浏览器面板使用固定行布局：

```css
.browser-panel {
  display: grid;
  grid-template-rows: 38px 40px 42px minmax(0, 1fr);
}

.browser-content {
  min-height: 0;
}

.browser-content webview {
  width: 100%;
  height: 100%;
}
```

Dock TabStrip、浏览器标签栏和工具栏占用独立 DOM 行，`<webview>` 只占用最后一行。禁止用覆盖整个 Dock 的绝对定位来放置 `<webview>`，以避免网页覆盖菜单和工具栏。

`<webview>` 是外层 DOM 中的元素，但其页面运行在隔离的 renderer 上下文，不能直接访问宿主 DOM。设计目标是视觉和交互一体，而不是共享网页内部 DOM。

### 5.3 浏览器 Tab 状态

每个浏览器 Tab 保存：

- 稳定的 Tab ID。
- 当前 URL 和页面标题。
- 加载状态。
- `canGoBack`、`canGoForward`。
- session partition。
- 页面恢复状态。
- 最近一次加载错误。

`BrowserTabStore` 只保存可序列化状态；`<webview>` DOM 节点和 Electron 实例由 `BrowserTabManager` 管理。

### 5.4 VS Code Webview 思路的借鉴范围

借鉴以下模型：

- 创建、激活、隐藏、销毁的生命周期。
- 页面状态 `getState`/`setState`。
- 主客体之间的 `postMessage` 请求模型。
- 请求 ID、响应和错误封装。
- 资源和权限白名单。
- 页面隐藏时保留上下文。
- nonce 和 CSP 约束。

不复制 VS Code 的 Workbench、服务容器或扩展协议。普通远程浏览器页面默认不获得应用 IPC；只有受信任的本地 TencentDB Panel 页面才允许使用明确的 bootstrap 流程。

### 5.5 Electron `<webview>` 安全配置

主窗口启用：

```ts
webPreferences: {
  webviewTag: true,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
}
```

浏览器页面使用受控 session。默认禁止任意 `window.open`、协议跳转、下载和权限申请；需要放行的行为由 Main 进程显式处理。远程页面不得接收包含凭据、bootstrap token 或内部 IPC command 的 preload API。

## 6. TypeScript 运行时重写

### 6.1 Main、preload 和 Renderer 边界

```text
Renderer React
└─ window.gren.*（preload 暴露的最小 API）
   └─ ipcRenderer.invoke/send
      └─ Electron Main ipcMain.handle/on
         └─ TypeScript/Node service
```

preload 不暴露通用 `ipcRenderer`，每个 API 都有固定名称、输入校验和返回类型。

### 6.2 Rust 能力映射

| 当前能力 | TypeScript 实现 |
| --- | --- |
| Tauri `invoke` command | `ipcMain.handle` command registry |
| Tauri event | `webContents.send` 和订阅清理 |
| Pi sidecar RPC | `child_process.spawn` + JSONL framing |
| Pi 进程监督 | `PiRuntime` + 退出、重启和超时处理 |
| TencentDB PanelRuntime | `TencentDbRuntime` |
| KnowledgeClient | `fetch`/`undici` HTTP client |
| 文件读写 | `fs/promises` + workspace containment 校验 |
| Git | `child_process` + 参数数组调用 |
| PTY 终端 | `node-pty` |
| SQLite | `better-sqlite3` |
| 系统凭据 | `keytar` |
| Tauri 窗口控制 | `BrowserWindow` |
| 对话框和打开外部路径 | Electron `dialog`、`shell` |

业务逻辑使用 TypeScript/Node。若 npm 依赖包含原生二进制，属于依赖实现细节，不重新引入 Rust 业务模块。

### 6.3 TencentDB 对接

Electron Main 启动并监督：

```text
resources/runtime/
├─ node/
├─ pi/
└─ tencentdb-memory/
   ├─ core/
   ├─ knowledge/
   └─ panel/
```

现有 `build-sidecar.mjs` 和 `build-tencentdb-memory.mjs` 迁移到新工程的 `scripts`，保留以下约束：

- Node 运行时版本固定。
- TencentDB 上游仓库和 commit 固定。
- 下载内容进行 SHA-256 校验。
- manifest 记录来源和资源摘要。
- Panel 只监听 loopback 地址。
- Panel bootstrap token 只存在 Main/Node 层。

右 Dock 的 TencentDB 页面通过 Main 获取一次性 Panel 地址，再由 `<webview>` 加载。普通浏览器 Tab 不共享 TencentDB 管理凭据。

## 7. 迁移阶段与交付物

### 阶段 1：创建 Electron 工程

交付物：

- `electron-agent` 最小 Electron + TypeScript + React + Vite 工程。
- 开发、构建、测试和打包脚本。
- 安全的 `main.ts`、`preload.ts` 和空白 Renderer。
- 原 `tauri-agent` 无文件改动。

验证：Electron 窗口可以启动，Renderer 可以加载，TypeScript 检查和基础测试通过。

### 阶段 2：评估并迁移前端

交付物：

- 从 `tauri-agent/src` 拷贝的 React 前端快照。
- 前端资源、主题、状态和 Dock 组件清单。
- Tauri API 依赖清单及 TypeScript API 替代接口。
- 迁移后的前端可以在 Electron Renderer 编译。

验证：前端编译通过，原有纯 UI 测试可以运行，未迁移的 Tauri 调用全部有明确记录。

### 阶段 3：实现右 Dock `<webview>` 浏览器

交付物：

- `BrowserPanel`。
- `BrowserTabStore`。
- `BrowserTabManager`。
- DOM 工具栏、标签栏、菜单和导航操作。
- `<webview>` 生命周期及事件处理。
- 浏览器加载错误、导航拦截和 session 管理。

验证：右 Dock 可以打开、调整宽度、创建和切换浏览器标签；网页不会覆盖 Dock TabStrip、地址栏或菜单。

### 阶段 4：TypeScript 重写 Rust 能力

建议顺序：

1. IPC command registry 和错误模型。
2. 文件、Workspace、Git 和外部打开能力。
3. Pi RPC 和会话事件。
4. 终端和 PTY。
5. TencentDB Core、Knowledge、Panel 客户端与进程监督。
6. SQLite、凭据存储和窗口能力。

验证：每个服务先有单元测试，再接入 Renderer；原 Tauri 项目继续独立构建。

### 阶段 5：完成运行时对接和打包

交付物：

- Pi、Node、TencentDB 资源进入 Electron 安装包。
- Main 进程启动、健康检查、退出清理和重启策略。
- Renderer API 全部切换到 Electron preload。
- Windows、macOS、Linux 的资源路径和可执行文件处理。

验证：干净机器不安装系统 Node 也能启动；应用退出后子进程不存在；打包应用通过浏览器和 TencentDB 冒烟测试。

## 8. 错误处理

- IPC 输入不符合 schema 时立即拒绝，并返回稳定错误码。
- Pi 或 TencentDB 子进程启动失败时显示运行时状态，不让 Renderer 无限等待。
- Panel 启动使用端口文件、健康检查和有限次数重试。
- `<webview>` 加载失败时显示面板内错误状态，保留重试和复制 URL 操作。
- 浏览器导航被策略拦截时记录原因，不静默跳转。
- 应用退出时先停止接受新请求，再停止 Pi、TencentDB 和 PTY 子进程。
- 所有用户可见错误去除凭据、token、命令行和本地敏感路径。

## 9. 测试策略

### 单元测试

- Browser Tab 状态和排序。
- 导航状态更新。
- WebView 生命周期状态机。
- IPC 输入校验和错误映射。
- Workspace 路径 containment。
- Pi JSONL framing。
- TencentDB URL、token 和健康检查。
- 子进程退出和重启状态。

### 集成测试

- Electron Renderer 与 preload IPC 通信。
- 右 Dock 调整宽度后 `<webview>` 尺寸同步。
- Dock Tab 与浏览器内部 Tab 切换。
- Panel loopback 页面加载和 bootstrap 流程。
- 应用关闭后的进程回收。

### 打包冒烟测试

- 安装包不依赖系统 Node。
- 运行时资源路径在开发和打包环境一致。
- 远程网页无法访问应用 IPC。
- Windows、macOS、Linux 目标平台的 sidecar 名称和权限正确。

## 10. 验收标准

- `tauri-agent` 的 git diff 为空，除非用户后续明确要求修改。
- `electron-agent` 可以独立安装、开发、测试和打包。
- 右侧 Dock 浏览器使用 `<webview>`，不是 `WebContentsView`。
- DOM 工具栏、TabStrip、地址栏和菜单始终位于 `<webview>` 之外。
- 浏览器标签可以导航、后退、前进、刷新、关闭和恢复状态。
- 现有静态 `page` Tab 行为不被浏览器 Tab 替代。
- Pi 和 TencentDB 运行时由 Electron Main 启动并监督。
- TypeScript API 覆盖现有 Rust/Tauri 命令所需能力。
- 打包应用无需用户安装 Node。
- 凭据和 bootstrap token 不进入远程网页或 Renderer 普通 DOM。

