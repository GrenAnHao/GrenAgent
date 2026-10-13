# Agent Note: 桌面端主线是 Electron，Tauri 版封存

Status: implemented

## Problem

桌面端最早是 Tauri 2 + Rust（`tauri-agent/`，6eade8f7 起）。2026-08-30 起把 React 前端快照和桌面能力迁到 Electron（8e56271a「迁移 React 快照并抽象桌面能力」、13f67eb2「迁移交互式 PTY Shell」、270a2f72「迁移 MCP 文件与子代理命令」）。

原因（用户说明）：避免后期留下技术债；同技术栈开发更全面；还能支持内置浏览器，更加自由。

## Decision

- `electron-agent/` 是唯一维护的桌面实现。
- `tauri-agent/` 于 2026-09-13 封存：3f26a480 先收录未提交改动，bb23b08c 从索引中移除 tauri-agent 与 Tauri 发布流水线；完整快照见 git 标签 `archive/tauri-agent`（`git checkout archive/tauri-agent -- tauri-agent` 可取回）。
- `docs/architecture.md` 里涉及 Tauri 的段落都标为历史，只作迁移对照；接口对照见 `electron-agent/docs/tauri-api-inventory.md`。

### 涉及文件

- `electron-agent/`
- `docs/architecture.md`

### 来源

- 8e56271a
- 13f67eb2
- 270a2f72
- 3f26a480
- bb23b08c

## Alternatives considered

- **继续维护 Tauri 版 / 双端并行**：不采用，理由同上：避免后期技术债、统一技术栈（用户说明）。

## Consequences

- 不再修 Tauri 版的 bug，也不往 `tauri-agent/` 加功能；历史文档（含 `docs/superpowers/archive/plans/` 的 hermes / grenagent 计划）只当考古材料。
- Rust 侧能力（code_intel、usage_report 等）已在 Electron 侧重写，见 `docs/architecture.md`。

## Verification

verify: n/a 回填的历史决定，源提交未记录验证
