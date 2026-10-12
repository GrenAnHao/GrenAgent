---
title: 拖动停靠面板时自己算宽度，不走 re-resizable 的逐帧测量
status: active
date: 2026-10-11
scope: electron-agent/layout
files:
  - electron-agent/src/components/ResizeHandle.tsx
  - electron-agent/src/features/chat/VirtualizedMessageList.tsx
  - electron-agent/src/hooks/useElementMeasure.ts
  - electron-agent/src/features/fileExplorer/useElementSize.ts
supersedes:
superseded_by:
---

## 背景

对话区旁边开着文件浏览器、预览一篇长 markdown 时，拖中间分隔条会明显掉帧。trace 里主线程每帧要做三件事：`re-resizable` 的 `onMouseMove` 往父节点插探测元素、改 `flex-wrap` 再量父尺寸，接着 `flushSync` 渲染，再用 `getBoundingClientRect` 夹取；DraggablePanel 外层 0.2s 的宽度过渡让尺寸变化再排一版；对话列表在这次程序化滚动里来回切换 `pointer-events`，已挂载消息（代码高亮的 span 上千个）整列重算样式，单次 40–60ms。同一台机器上，长对话加长预览来回拖约 1.5 秒，长帧合计约 450ms，而且每一轮都有。

## 决定

拖动由 `ResizeHandle` 自己用 pointer 事件算新尺寸，写受控 `size`。`DraggablePanel` 只保留折叠动画和外观，`resize={false}`。拖动开始时把外层和内部 Resizable 的 inline `transition` 写成 `none`，松手后下一帧恢复，折叠 / 展开的 0.2s 动画还在。双击手柄回到挂载时的尺寸。

尺寸观察者在回调里读 `ResizeObserver` entry 的 `borderBoxSize`，不再 `getBoundingClientRect`。只关心阈值的组件用 `useElementMeasure`：派生结果不变就不重渲染。文件树宽度、markdown 是否分栏、输入栏折进「更多」的是哪几项，都走这条。

虚拟列表把条目容器的 `pointer-events` 计算值钉成 `auto`。virtua 滚动时照旧写 inline `none`，但不再继承到已挂载的消息上。

## 放弃的方案

- 继续用 re-resizable，只把 `onResize` 节流到一帧一次。节流不到库里面：每个 mousemove 仍会改父节点的 `flex-wrap`、插入探测元素，再 `flushSync`。这是 trace 里最贵的脚本时间。
- 拖动时给 aside 加一个 class，用子选择器关掉过渡。过渡是关了，但选择器让整棵面板子树的样式失效。长对话一次重算约 1900 个元素，40–60ms，比过渡本身更贵。所以改成直接写那两个节点的 inline style。
- 给离屏消息加 `content-visibility: auto` 来少排版。可见区的 markdown 照样要排，而且会干扰 virtua 测高。卡顿的大头是上面两处强制排版和样式重算，不在可见区那一次正常排版。
- 不动 virtua 的 `pointer-events`。拖分隔条引起的程序化滚动每次切换都会整列重算样式，长对话侧的长帧去不掉。

## 后果

滚动过程中消息可以被点到，hover 也会生效。virtua 在滚动时写 `pointer-events: none` 就是为了避免甩动结束时误点到一条消息上。如果这成为问题，再收窄成只在拖分隔条期间钉住。

拖动期间的宽度仍通过 `onResizeLive` 写入 layout store，给另一侧让位用。订阅方拿到的是可见性布尔值，宽度变但可见性不变时对话树不会因此重渲染。

可见区对话的正常排版还在：长对话每帧大约十几毫秒。这是宽度变化本身的成本，不是再叠加的强制布局。
