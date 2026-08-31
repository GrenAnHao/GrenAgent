# 桌面能力迁移清单

React 快照中的桌面能力已统一收口到 `src/platform/runtime.ts`。业务模块不再直接依赖具体桌面框架，后续主进程只需为同名命令注册 handler。

| 能力 | 平台接口 | 当前调用模块 |
| --- | --- | --- |
| 命令调用 | `invoke(command, args)` | 文件、Pi、Agent Data、终端、Workspace、MCP、技能 |
| 事件订阅 | `listen(event, handler)` | Pi、终端 |
| 流式回调 | `Channel<T>` | Provider diagnostics |
| 目录选择 | `openDirectory()` | 新建项目、技能导入 |
| URL / 文件打开 | `openUrl`, `openPath`, `revealItemInDir` | 页面、视觉卡片、扩展卡片、侧栏 |
| 窗口控制 | `getCurrentWindow()` | 自定义标题栏 |
| 文件拖放 | `getCurrentWebview()` | 聊天输入区 |

## 迁移约束

- 原 Tauri 工程保持不变，仅复制 React 快照作为迁移输入。
- Electron renderer 只通过 preload 暴露的 `window.gren` 访问桌面能力。
- `contextIsolation`、`sandbox` 和关闭 Node integration 保持开启。
- 具体命令注册在后续 IPC 任务中完成；未注册命令会返回明确错误。
