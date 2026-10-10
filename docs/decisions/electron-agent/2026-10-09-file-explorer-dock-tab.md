---
title: 「文件」标签升级成文件浏览器：按层懒加载、CodeMirror 6 直接用、只监听展开的目录
status: active
date: 2026-10-09
scope: electron-agent
files:
  - electron-agent/electron/app/fileService.ts
  - electron-agent/electron/app/fileWatchService.ts
  - electron-agent/electron/ipc/register.ts
  - electron-agent/src/lib/files.ts
  - electron-agent/src/features/fileExplorer/
  - electron-agent/src/features/dock/FileTreeBody.tsx
  - electron-agent/src/features/dock/dockCloseGuards.ts
  - electron-agent/src/features/dock/DockPanel.tsx
supersedes:
superseded_by:
---

## 背景

Dock 里已有 Ctrl+P 打开的「文件」标签，但它只是一棵一次性读到 6 层、每层 200 项的静态树，点文件没有反应。要能看项目结构：左边树，右边内容，markdown 默认预览，代码默认只读，都能切到编辑并保存。渲染层没有任何代码编辑器。

## 决定

- 不新加标签类型，`'file'` 标签的正文换成 `FileExplorer`。标签 id 同时用作目录监听、关闭守卫、未保存登记的键。
- 主进程加 `list_dir`（只列一层；跳过 `node_modules`、`.git`、`dist`、`out` 和符号链接，点开头的文件照常列；单层上限 5000 项）、`read_file_view`（开头 8000 字节有 NUL 就当二进制只回大小；超过 5MB 只读开头、标截断）、`open_workspace_file`，以及 `watch_workspace_dirs` / `unwatch_workspace_dirs`。路径校验沿用 `safeWorkspacePath`（resolve + realpath 后必须在工作区内）。保存沿用已有的 `write_file`（临时文件 + rename）。
- 目录监听：渲染层把「根 + 展开着且列过的目录 + 打开文件所在目录」报给主进程，主进程每个目录开一个非递归 `fs.watch`，120ms 合并一批，经 `files://changed` 推回发起的窗口。`node_modules` / `.git` / `dist` / `out` 名下的事件直接丢。窗口销毁时按 webContents id 一起关。
- 编辑器直接用 CodeMirror 6 的各个包，不套 `@uiw/react-codemirror`。只读、主题、语言、对比、换行符各占一个 Compartment，原地重配；只有换文件 / 重新载入时 `setState`，撤销历史随之清空。编辑器组件懒加载；markdown 只看不改时不挂编辑器。
- 打开文件时记下它的换行符（看第一个换行），写进 `EditorState.lineSeparator`。CodeMirror 默认把 CRLF 读成 LF、保存时整份写成 LF。
- Markdown 预览用对话里的 `LazyMarkdown`，不另装 react-markdown 一套。
- 磁盘变更以内容比对把关：读回来和 `original` 一样就什么都不做（包括自己刚保存触发的事件）；没有本地修改就静默换成新内容；有本地修改才提示，可以重新载入或保留。选过保留的那份磁盘内容不再提示。
- 未保存修改：切文件、关标签（`DockPanel` 关闭前查 `dockCloseGuards`）、关窗口（`beforeunload` 拦下后自己弹框，处理完再 `close()`）都走同一个「保存 / 放弃 / 取消」。

## 放弃的方案

- 新建 `'files'` 标签类型：要改 dockStore 联合类型、图标、启动器、快捷键五六处，而现有 `'file'` 标签本来就是这个用途、已经接好了 Ctrl+P。
- `@uiw/react-codemirror`：它在 props 变化时重配整套扩展，和按 Compartment 精确切只读 / 主题的做法重复；要的 React 接线不到二十行。
- Monaco：体积大一个量级，主题要单独映射，Electron 里还要处理 worker 加载；这里只需要查看和轻量编辑。
- react-markdown + remark-gfm + rehype-highlight：对话正文已经有一套带 mermaid、代码高亮、主题联动的渲染，再装一套预览会和对话里看到的不一样。
- chokidar / 递归 `fs.watch` 整个工作区：Linux 上递归监听要给每个子目录挂 inotify（含 node_modules），Windows 上装包、git 操作会刷屏；树只关心展开的几层，按目录非递归监听足够。
- isbinaryfile：git 的「开头 8000 字节里有没有 NUL」规则已经够用，而且和 git diff 判断二进制的结果一致，不必为此加依赖。
- 超过 5MB 显示「不支持预览」：日志一类大文件看开头最有用，改成只读显示前 5MB 并标截断。

## 后果

- Windows 上被监听的目录被删时 `fs.watch` 报 EPERM，这时关掉那个监听并让渲染层重列；目录被别的程序删除期间，句柄可能让父目录短暂删不掉，直到收起或事件到来。
- 符号链接不列出：指向工作区外的链接按校验也读不了，列出来只会点了报错。
- 混用换行符的文件保存后会统一成第一个换行的样式。
- 文件浏览器保存走 rename 覆盖，POSIX 上原文件的权限位和硬链接会丢；以后有人在乎再改成原地写。
- 多标签（同时开几个文件）没做；`useOpenFile` 的状态是单个文件，要做时改成按路径的 Map。
