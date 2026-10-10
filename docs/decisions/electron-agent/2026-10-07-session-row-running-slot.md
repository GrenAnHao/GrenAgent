---
title: 运行中的会话行：转圈和「更多」共用行尾一格，悬停原位互换
status: active
date: 2026-10-07
scope: electron-agent
files:
  - electron-agent/src/features/sessions/SessionItem.tsx
  - electron-agent/ui-harness/scenarios/session-row.tsx
  - electron-agent/ui-harness/probes/session-row.mjs
supersedes:
superseded_by:
---

## 背景
运行中的会话行行尾有转圈。悬停时原来是在转圈旁边再多出一个「更多」按钮，行尾一下多占 32px（按钮 24px + 间距 8px）：标题被挤窄，转圈被推向左边，扫列表时整列文字跟着跳。

## 决定
转圈和「更多」叠在同一个 24×24 的格子里（CSS grid 的同一格）。悬停整行时转圈 `visibility: hidden`、按钮 `visible`，移开换回来。格子边长等于 `ActionIcon size="small"` 的边长，悬停前后标题宽度和格子位置都不变，按钮中心就是转圈中心。

运行中的行把「更多」提前挂上，悬停只剩 CSS 切换；空闲行仍然首次悬停才挂（侧栏长列表的性能约定）。格子对运行和空闲两种行都是同一层包裹，`running` 变化时 `RowActions` 的位置不动。

ui-harness 的 `session-row` 场景断言格子和按钮同尺寸、悬停前后标题宽度不变、按钮中心落在转圈原位。

## 放弃的方案
- 沿用首次悬停才挂「更多」：`:hover` 立刻把转圈藏了，按钮要等 React 下一次提交才出现，首次悬停会空一帧。
- 运行行和空闲行各写一套子树：`running` 一变，`RowActions` 换了位置被重新挂载，开着的菜单跟着被卸载。
- 格子只留转圈那么宽（14px），按钮向两侧溢出：转圈位置和以前完全一样，但运行行的按钮离行右缘只剩 3px，和空闲行（8px）不在同一列。
- 只在鼠标正好停在转圈上才换成按钮：悬停整行时没有任何入口，菜单只有指准转圈才找得到，和空闲行「悬停整行出现操作」不一致。

## 后果
运行中的行转圈居中在 24px 的格子里，比以前靠近标题约 5px，标题可用宽度少 10px。`24px` 写死在 `SessionItem` 的样式里，和 `ActionIcon size="small"` 的边长绑定，换了尺寸要同步改，`session-row` 场景会在两者不一致时失败。运行中的行常驻一个 Dropdown，同时运行的会话很少，可以接受；将来要是大量行同时显示运行态，重新评估提前挂载。
