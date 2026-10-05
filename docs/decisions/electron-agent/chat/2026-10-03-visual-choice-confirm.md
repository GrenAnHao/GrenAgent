---
title: 视觉设计先切换方案，确认后才提交
status: active
date: 2026-10-03
scope: electron-agent
files:
  - electron-agent/src/features/visual/frameAssets.ts
  - extensions/visual-companion/index.ts
  - extensions/fable-behavior/prompts/modes/brainstorm.md
supersedes:
superseded_by:
---

## 背景
页面设计预览里的选项经常同时用来切换方案。点到 `data-choice` 会立刻 `postMessage` 成 `visual-choice`，`read_visual_choice` 随之返回，后面的方案就看不成。

## 决定
选项点击只选中，并继续跑页面自己的切换逻辑。预览底部注入确认条：有选项时是「确认提交」，没有选项的页面稿是「确定页面」。只有点这个按钮才把选择回传。

## 放弃的方案
- 确认按钮放在卡片或面板外壳上：选中态在 iframe 里，外壳拿不到当前方案，两处预览还要各做一遍。
- 继续一点即提交，只让模型把切换控件写成不带 `data-choice`：页面设计的提示词会把「看方案」和「选方案」写在同一个选项上，宿主拦不住。

## 后果
旧页面如果用 `brainstorm.choice()` 期望立即提交，现在只会选中。没有选项、也没有 `.mockup` / `.split` / `.cards` 的片段不会出现确认条。
