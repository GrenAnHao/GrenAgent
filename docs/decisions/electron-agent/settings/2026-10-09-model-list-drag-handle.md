---
title: 供应商模型列表用手柄拖动排序，顺序即 models.json 里的顺序
status: active
date: 2026-10-09
scope: electron-agent/settings
files:
  - electron-agent/src/features/settings/SortableModelCards.tsx
  - electron-agent/src/features/settings/ProviderModelCard.tsx
  - electron-agent/src/features/settings/ProvidersSettings.tsx
supersedes:
superseded_by:
---

## 背景

供应商的模型卡片只能按添加顺序排，调整位置只能删了重加。models.json 里模型的顺序就是模型选择器里的顺序。

## 决定

每张卡片左侧加一个拖动手柄，用已有的 @dnd-kit/sortable 排序，只沿竖直方向拖；指针拖动 4px 才开始，手柄也能用键盘（空格拿起、方向键移动、空格放下）。排序按每行的临时 `_uid`，展开状态跟着卡片走，保存时按新顺序写 models.json。

## 放弃的方案

- 整张卡片都能拖：卡片里全是输入框和下拉框，按住输入框选字会变成拖动。
- 每张卡片加「上移 / 下移」按钮：模型多时要点很多下，卡片头一行也已经很挤。

## 后果

拖动依赖手柄的命中区域，手柄只有 20px 宽；以后卡片头再加控件时别把它挤没。dnd-kit 在 jsdom 里量不到尺寸，拖动只在 ui-harness 的 `provider-model-list` 场景里验证，单测只覆盖 `moveById`。
