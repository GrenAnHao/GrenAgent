---
title: probe 的 t.drag 在 mousemove 上带 leftButtonDown，pointer capture 才能跟住整段拖动
status: active
date: 2026-10-09
scope: electron-agent/ui-harness
files:
  - electron-agent/ui-harness/probe.mjs
supersedes:
superseded_by:
---

## 背景
测活停靠区的分隔条用 `setPointerCapture` 跟手（和 `FileDiffBlock` 的滚动条同一写法）。probe 里 `t.drag` 上拖 120px，高度只涨了 15px，正好是 8 步里的第一步。给分隔条和 document 记 pointer 事件后发现：`sendInputEvent` 的 mousemove 只写了 `button: 'left'`，pointermove 的 `buttons` 是 0，Chromium 在第一个 move 后释放捕获，后面的 move 都落到了鼠标下面的别的元素上。真实鼠标拖动时左键是按着的，组件本身没问题。

## 决定
`t.drag` 中途的每个 mousemove 都加 `modifiers: ['leftButtonDown']`，和真实拖动时的按键状态一致。在此之前没有 probe 用过 `t.drag`。改完跑了 skill 的 `smoke.mjs`（含拖拽项），以及 provider-diagnostics、session-row、command-pill 三个场景，全部通过。

## 放弃的方案
- 组件改成在 document 上听 pointermove、不用 pointer capture：能绕过这个问题，但组件为了测试工具换写法，而且 harness 的毛病还在，下一个用 capture 的拖动照样会踩。
- probe 里不用 `t.drag`，手写 `sendInputEvent`：每个要拖的场景都得自己记住带这个修饰键，不如在工具箱里修一次。

## 后果
以后用 pointer capture 的拖动（分隔条、滑块、拖拽排序）都能用 `t.drag` 断言。electron-ui-harness skill 模板里的 `probe.mjs` 如果是同一写法，也有同样的问题，从模板新建的项目要同步这一行。
