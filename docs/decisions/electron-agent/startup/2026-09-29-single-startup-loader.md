---
title: 冷启动只保留一个品牌加载页，由 index.html 静态首屏承担
status: active
date: 2026-09-29
scope: electron-agent/startup
files:
  - electron-agent/index.html
  - electron-agent/src/lib/bootSplash.ts
  - electron-agent/src/lib/bootSplash.test.tsx
  - electron-agent/src/App.tsx
  - electron-agent/src/components/RootErrorBoundary.tsx
supersedes:
superseded_by:
---

## 背景
冷启动先后出现两个加载页：`index.html` 的 `#boot-splash` 在 JS 加载期显示蓝色圆环，React 挂载后换成 `FullscreenLoading` 的 GrenAgent 品牌动画，直到首个对话就绪。用户只要品牌页。JS 加载期本身有好几秒，只删圆环会让这段变成黑屏。

## 决定
品牌页整个搬进 `index.html`：`#boot-splash` 放在 `#root` 之外，内联 π 字标和描边动画，首帧即显示。React 首次提交只清空 `#root`，碰不到它，动画不会重播。`Workspace` 在 `appBooted` 变为 true 时、`RootErrorBoundary` 在渲染崩溃时调用 `dismissBootSplash()`：先加 `is-leaving` 关掉整屏拖拽区和指针事件，0.45s 淡出后移除节点。`FullscreenLoading` 删除。首屏颜色固定为原 `FullscreenLoading` 的兜底色（`#0b0d12` 底、`#4c8bf5` 字标）。

## 放弃的方案
- 只删圆环，加载指示仍交给 `FullscreenLoading`：JS 加载期只剩深色底，用户实际看到好几秒黑屏。
- `index.html` 画一份同样的品牌页，React 挂载后仍由 `FullscreenLoading` 接手：接手时是新节点，描边动画从头播放，衔接处会跳；两份实现还要同步维护。
- 首屏颜色绑定 `--gren-*`：这些变量要等 React 挂载后 ThemeBridge 才写到 `<html>` 上，加载页会在中途从兜底色跳到主题色（默认 github 深色方案的底色是 `#0b0d12` → `#161b22`）。要让首帧就跟随主题，得把上次运行的主题色缓存起来、由内联脚本在首帧前读出，暂不做。

## 后果
- 加载页不随主题：浅色主题下也是深色加载页，就绪后淡出到浅色界面。
- `index.html` 里多一份 π 路径，`src/lib/bootSplash.test.tsx` 锁住它与 `PiBrandLogo` 一致，并锁住首屏在 `#root` 之外。
- 首屏不再随 React 挂载自动消失。以后新增的「启动完成」或「启动失败」出口都要调用 `dismissBootSplash()`，否则整屏拖拽层会一直盖在界面上。
