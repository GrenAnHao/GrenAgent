---
title: 扩展面板铺满面板区并统一放大一档，移除「扩展」页签
status: active
date: 2026-10-08
scope: electron-agent/extensions
files:
  - electron-agent/src/features/extensions/ExtensionsPanel.tsx
  - electron-agent/src/features/extensions/libraryStyles.ts
  - electron-agent/src/features/extensions/CommandsPanel.tsx
  - electron-agent/src/features/extensions/RulesPanel.tsx
  - electron-agent/src/features/extensions/McpServerCard.tsx
  - electron-agent/src/features/extensions/NativeSkillsPanel.tsx
  - electron-agent/src/features/extensions/PromptBodyEditor.tsx
supersedes:
superseded_by:
---

## 背景
扩展面板内容区限宽 680px 居中，正文 12–13px，按钮 / 开关 / 分段控件全是 small，命令与规则的列表只占 680 的 42%。宽窗口下整块缩在中间，用户评价「小里小气」。「扩展」页签（Pi Package 市场）用户认为没有意义。

## 决定
- 去掉 `max-width`，内容铺满面板区，左右留 32px；页签栏高 50、字号 14。
- 五个页签统一放大一档：所有字号 +1，大标题 17→20，标题图标 34→40；按钮、开关、分段控件回到默认尺寸；卡片内边距 11/14→15/18。
- 命令 / 规则：左列表固定 300px，编辑区占满剩余；列表行内边距 10/12；头部补上和其他页签一致的图标与计数。
- 命令 / 规则的分栏纵向撑到面板底边（最小 420px，窗口再矮时外层滚动），列表与编辑区各自滚动，提示词 / 规则正文框吃掉剩余高度，不再手动拖高。
- 移除「扩展」页签及 `PiPackagesPanel` / `PackageMarketplaceModal`。主进程 `PiPackageService` 与 `package_*` IPC 暂留，已安装的包照常加载。

## 放弃的方案
- 放宽到 960px 居中、字号按钮同上：在视觉伴侣里与铺满并排对比，用户选了铺满。
- 只放大命令 / 规则两页：用户要求所有页一样处理。
- 同时删主进程 package 服务：牵涉 IPC、settings 写入和 SDK 包管理，超出本次 UI 改动，单独处理。

## 后果
- 超宽窗口下 MCP / 技能卡片会拉得很长；如果嫌长，再加一个较大的上限（如 1200px）。
- 市场安装的 Pi Package 在界面上无法再开关或卸载，只能改 settings 的 `packages`。
