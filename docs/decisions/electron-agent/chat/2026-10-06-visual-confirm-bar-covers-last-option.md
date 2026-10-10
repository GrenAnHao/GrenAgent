---
title: 视觉设计面板里确认条不能盖住最后一个选项
status: active
date: 2026-10-06
scope: electron-agent
files:
  - electron-agent/src/features/visual/frameAssets.ts
  - electron-agent/src/features/visual/frameAssets.test.ts
  - electron-agent/ui-harness/scenarios/visual-panel.tsx
supersedes:
superseded_by:
---

## 背景
右侧「视觉设计」面板里，页面滚到底后底部的确认条盖住了第二个选项，点不到 B。原因有两个，叠在一起：

1. 撑满规则 `body > *:not(script):not(style) { display: flex; flex-direction: column }` 命中了确认条。确认条是 `body` 的直接子节点，本来是 fixed 的单行横条，被改成竖向 flex 后提示和按钮分成两行，约 124px 高，超过它给 `body` 预留的 64px。
2. 撑满时 `html, body` 都是 `height: 100%`。内容放不下时溢出 `body` 的盒子，溢出内容后面没有 `padding-bottom`，预留的 64px 不参与滚动范围。条是单行（56px）也一样盖住最后 56px。

上一条笔记（2026-10-04-visual-confirm-style-text）只排除了 `style`，没有排除确认条本身。

## 决定
- 撑满规则的选择器再排除 `#visual-confirm-bar`。
- `html` 保持 `height: 100%`，`body` 改成 `height: auto; min-height: 100%; box-sizing: border-box`。内容矮时 `flex: 1 1 auto` 照旧吃掉剩余空间；内容高时 `body` 跟着内容长，整页滚动，`padding-bottom` 留在最后一个元素后面。

ui-harness 新增 `visual-panel` 场景：真实 `VisualPanel` + `HtmlPreview`，长页面滚到底断言 B 在条上方、hit test 命中 B、点 B 只选中、点确认回传 `change`；矮页面断言比较区仍撑满。单测补两条：撑满规则不命中确认条；`body` 不再定高。

## 放弃的方案
- 只排除确认条、`body` 仍定高：短页面和刚好放下的页面没问题，但溢出的长页面最后一个选项仍被盖住 56px，harness 里复现过（B.bottom 844 对条.top 788）。
- 保持 `body` 定高，让 `body` 自己当滚动容器（`overflow-y: auto`）。没有实测，按规则判断放弃：要靠浏览器把 flex 容器末尾的 padding 算进滚动范围，并且滚动根从视口换成 `body`，`window.scrollTo`、自动高度脚本读的 `documentElement.scrollHeight` 都得跟着改。
- 在 `body` 末尾加一个占位元素撑出确认条的高度。没有实测，按布局推断放弃：溢出发生在 `#claude-content` 内部，占位元素会落在被压缩后的 `#claude-content` 盒子后面，仍被溢出内容盖住；整页文档里 `#claude-content` 还不存在，两种页面得分别处理。
- 用 ResizeObserver 量确认条实际高度、写 CSS 变量给 `body` 当底边距：条现在是固定的单行，64px 够用；等条会变高再说。
- 给确认条加大 `padding-bottom` 到 130px：只是把症状推远，短页面会多出一大块空白。

## 后果
- 面板和全屏预览里，内容比面板高时不再把比较区压成带内部滚动条的小框，改为整页滚动。内容比面板矮时行为不变。
- 以后给 `body` 直接子节点加 `display`，除了 `script` / `style`，还要排除 `#visual-confirm-bar`。
- 确认条高度如果超过 64px（例如提示文案允许换行），要同步改预留值，或改成量实际高度。
- 内联卡片（不撑满）、浏览器里打开的整页没有走这条规则，本次没有改，也没有场景覆盖。
- harness 里点不进沙箱 iframe（离屏渲染下鼠标事件到不了跨进程 iframe），「点击」是对 `elementFromPoint` 的最上层元素派发 `click`，不是真实鼠标事件。见 AGENTS.md「运行的坑」。
