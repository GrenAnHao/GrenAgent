# Agent Note: 技能导入使用专用文件选择桥接

Status: implemented

## Problem

技能页把无参数的 `openDirectory` 别名为通用对话框，并给 ZIP、Markdown 和目录导入都传入选择器选项。真实 preload 只暴露 `pickDirectory()`，主进程固定打开目录选择器，因此文件过滤选项丢失，ZIP 与 SKILL.md 无法选择实际文件；类型检查同时报出三处 TS2554。

## Decision

保留 `pickDirectory()` / `openDirectory()` 的无参数旧契约。增加可选 `GrenRuntimeBridge.pickFile(options?)`、`openFile(options?)` 和独立 `gren:pick-file` IPC，只支持文件过滤器，主进程固定 `properties: ['openFile']`，取消或无结果返回 `null`。ZIP 与 Markdown 导入使用 `openFile`，目录导入仍用 `openDirectory`。选择器失败进入技能页原有错误提示；旧桥缺少 `pickFile` 时明确报错，不改开目录选择器。

`FilePickerOptions` 位于独立纯类型文件 `electron/ipc/filePicker.ts`，preload、主进程和渲染层共享该结构，渲染层不依赖主进程的整份契约导出。技能页把目录选择函数显式命名为 `pickDirectory`，与原有打开技能目录操作区分。

## Related notes

- [扩展页工作台](../feature/2026-10-31-extension-workbench.md)：部分重叠，保留三种导入入口需要补齐真实文件选择链路；本篇仅记录选择器契约，不改变布局或技能落盘协议。

检索未发现其他同主题活跃笔记，未替代或废弃已有决定。

## Alternatives considered

- 把目录选择器扩成通用 `showOpenDialog`，可复用一个方法承载所有选择场景；但这会改变已有无参数契约并向渲染层开放不需要的对话框选项，本次只增加独立文件能力。
- 文件入口沿用目录选择器不需要修改跨层契约；但选出的目录不符合 ZIP 或 SKILL.md 导入参数，无法满足现有入口的真实功能，因此不采用。

## Consequences

ZIP 与 Markdown 入口能够选择真实文件并传递过滤器，目录导入和打开技能目录仍是独立操作。新桥增加一个窄 IPC 通道，旧 preload 不会自动获得能力，需要运行匹配版本；显式错误暴露缺失能力，避免静默打开错误的选择器。技能安装、目录落盘、配置保存和现有布局保持原协议。

## Verification

运行 `cd electron-agent && npm test -- src/platform/runtime.test.ts electron/ipc/register.test.ts electron/preload.test.ts src/features/extensions/NativeSkillsPanel.test.tsx`：红灯为 10 失败、36 通过，缺失文件桥和误用目录选择器都被复现；最终 4 文件、46 用例通过，退出码 0。日志分别在 `.agents/evidence/2026-10-31-extension-workbench/skill-picker-red.log` 和 `skill-picker-green.log`。测试覆盖过滤器透传、单文件属性、取消/无结果、旧桥缺失明确报错、三种导入路由和真实错误提示。

本修复文件的 `git diff --check` 通过。测试替换系统对话框与磁盘 I/O，不替代原生文件窗口手动验收；扩展页集成 UI 与笔记树校验由父任务统一执行。
