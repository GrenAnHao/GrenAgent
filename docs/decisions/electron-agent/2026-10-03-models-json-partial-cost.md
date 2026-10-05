---
title: 模型价格缺缓存费率时补 0，避免整份 models.json 被拒绝
status: active
date: 2026-10-03
scope: electron-agent
files:
  - electron-agent/src/features/settings/providerConfigAdapter.ts
supersedes:
superseded_by:
---

## 背景

Pi 0.87 校验 `models.json` 时，`cost` 一旦出现就必须同时带 `input`、`output`、`cacheRead`、`cacheWrite`。任一模型缺字段，整份文件被丢弃，注册表里只剩 `auth.json` 里有密钥的内置供应商。设置页只编辑输入/输出价格，保存后会写出缺缓存费率的 `cost`。

## 决定

序列化时只要写了任一费率，就把缺的项补成 0。四个都没填则不写 `cost`。

## 放弃的方案

- 校验失败时只跳过坏模型：拒绝发生在 Pi 的 `ModelConfig.load`，应用侧拿不到部分加载结果。
- 设置页再加两个缓存价格输入：用户没填过，补 0 与「没有就填 0」的现有文案一致，不必多两个字段。

## 后果

缓存价格默认记成 0，用量统计里的缓存费用会是 0，直到用户以后在配置里写上真实费率。Pi 若把 `cost` 改成字段可选，这段补齐可以拿掉。
