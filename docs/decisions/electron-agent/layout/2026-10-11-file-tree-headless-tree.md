---
title: 文件树用 headless-tree，滚动交给浏览器
status: active
date: 2026-10-11
scope: electron-agent/file-explorer
files:
  - electron-agent/src/features/fileExplorer/FileTree.tsx
  - electron-agent/package.json
supersedes:
superseded_by:
---

## 背景

文件树用的是 antd `Tree.DirectoryTree` 的虚拟列表。列表一长，`@rc-component/virtual-list` 就 `preventDefault` 掉滚轮，自己把位移加进 React state，再从头扫描全部节点算可见区间。行高还按主题令牌估，量到真实高度后再改 `scrollTop`。所以滚动是一帧一跳，不是浏览器在滚。

## 决定

文件树换成 `@headless-tree/react`（`syncDataLoaderFeature`、`selectionFeature`、`hotkeysCoreFeature`），可见行用 `@tanstack/react-virtual`，滚动容器是普通的 `overflow: auto`。展开、筛选、打开文件、截断提示和「只列已展开的目录」仍走原来的 `useFileTree`。目录还没列过时，在 `setExpandedItems` 里调用 `loadDir`。数据变了调用 `rebuildTree()`。

选中行只跟着当前打开的文件，不把点过的目录记成选中。

## 放弃的方案

- 继续用 antd Tree，只把 `virtual` 关掉。两千个文件的目录会把节点全部挂上，这正是当初开虚拟列表的原因。
- 改 rc-virtual-list 的滚轮处理。可见区间仍是每个滚轮帧一次 React 渲染加一次全表扫描，行高修正也还在。
- 用 headless-tree 的 async data loader 再缓存一份子节点。目录列表已经在 `useFileTree` 里，监听刷新也写在那里。第二份缓存会和它分叉。

## 后果

新增依赖 `@headless-tree/core`、`@headless-tree/react`、`@tanstack/react-virtual`。行是定高 28px，滚动期间虚拟列表直接改 transform，可见区间变了才重渲染。

点目录会展开或收起，不会把选中从当前文件上挪走。
