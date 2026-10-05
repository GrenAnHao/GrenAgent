---
title: 打包时关闭 npmRebuild，沿用 node-pty 的 Node-API 预编译二进制
status: active
date: 2026-10-02
scope: build
files:
  - electron-agent/electron-builder.yml
supersedes:
superseded_by:
---

## 背景

`pnpm package` 在 `@electron/rebuild` 准备 `@homebridge/node-pty-prebuilt-multiarch@0.14.1` 时退出。node-gyp 报 `deps\winpty\src\winpty.gyp not found`。该包的 `files` 只含 `binding.gyp`、`lib/`、`scripts/`、`typings/`、Linux `prebuilds/` 和 `third_party/conpty`，不含 `src/` 与 `deps/winpty`。Windows 二进制由安装脚本里的 `prebuild-install` 解到 `build/Release`。`src/win/conpty.cc` 使用 `NODE_API_MODULE`。Electron 38.8.6（Node 22.22.0，ABI 139）可以直接 `require` 当前 Node 25（ABI 141）装好的 `conpty.node`。生产依赖闭包里带 `binding.gyp` 的只有这一个包。

## 决定

在 `electron-agent/electron-builder.yml` 设置 `npmRebuild: false`，打包使用安装时已经放下的 Node-API 预编译二进制。

## 放弃的方案

- 继续让 electron-rebuild 从源码编译：发布包里没有 `winpty.gyp` 和 `src/`，node-gyp 无法完成配置。日志里的 “space in the path” 是 node-gyp 警告，进程是在找不到 `winpty.gyp` 时退出的。
- 换到带 Electron 专用预编译的发行包：当前 `conpty.node` 已在 Electron 38.8.6 中加载，换包还要改 main 进程 external 与 import。
- `beforeBuild` 返回 false，再自己调用 `@electron/rebuild` 并 `ignoreModules`：electron-builder 会把 node_modules 视为外部处理，跳过生产依赖收集。
- 打包前删掉 `binding.gyp` 让 walker 跳过该模块：改的是 `node_modules`，下次安装会恢复。

## 后果

以后若加入必须按 Electron ABI 重编、且不是 Node-API 的原生模块，需要重新打开 `npmRebuild`，或只为那个模块提供 Electron 预编译。`build/Release/conpty.node` 来自安装时的 `prebuild-install`；打包前若该目录被 node-gyp 清掉，要重跑该包的安装脚本或 `pnpm install`，否则安装包里没有可用的 PTY。
