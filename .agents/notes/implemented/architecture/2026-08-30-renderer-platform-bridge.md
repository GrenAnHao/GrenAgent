# Agent Note: 渲染层只依赖 GrenRuntimeBridge，经单通道 gren:invoke 调主进程

Status: implemented

## Problem

渲染层从 Tauri 迁到 Electron 时（8e56271a「迁移 React 快照并抽象桌面能力」）需要一层隔离，使业务代码不直接引用宿主 API。

推断（依据：commit 8e56271a 新增的 `electron-agent/docs/tauri-api-inventory.md`、`src/platform/runtime.ts`；commit ec378965「允许无 preload 的浏览器预览启动」）：迁移时把 React 快照里原本调 Tauri 的桌面能力（invoke/listen/窗口/拖放/打开路径等）统一收口到一个平台接口，使「业务模块不再直接依赖具体桌面框架，后续主进程只需为同名命令注册 handler」，从而原样搬运 Tauri 版前端代码；同时 Electron 保持 `contextIsolation`、`sandbox`、关闭 Node integration，渲染层只能经 preload 暴露的 `window.gren` 访问；之后又借此支持无 preload 的浏览器预览。用户本人未确认此动机。

## Decision

- 业务代码只依赖 `src/platform/runtime.ts` 定义的 `GrenRuntimeBridge`，不直接引用 Electron；`window.gren` 由 `electron/preload.ts` 暴露。
- 没有 bridge 时降级为 `browserPreviewBridge`，渲染层可在纯浏览器预览态运行。
- 请求走单业务通道 `gren:invoke`（`electron/ipc/contracts.ts` 定义、按命令名分发）；事件走 `gren:event:` 通道。

### 涉及文件

- `electron-agent/src/platform/runtime.ts`
- `electron-agent/electron/ipc/contracts.ts`
- `electron-agent/electron/ipc/register.ts`
- `electron-agent/electron/preload.ts`

### 来源

- 8e56271a
- `docs/architecture.md`「总览」

## Alternatives considered

- **渲染层直接调 ipcRenderer / Electron API**：未见权衡记录。推断（依据同上）：会与开启的 contextIsolation/sandbox 冲突，且要逐处改写原 Tauri 调用。

## Consequences

- 新增主进程能力要同时在 `contracts.ts` 登记命令、在 bridge 暴露，浏览器预览实现给出降级行为。

## Verification

verify: n/a 回填的历史决定，源提交未记录验证
