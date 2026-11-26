# Agent Note: 桌面生产构建分别检查渲染层和主进程

Status: implemented

## Problem

桌面构建曾对没有源文件的 TypeScript 解决方案配置运行 `tsc`。它可以成功退出，却漏掉渲染源码、主进程重复方法和失效的测试夹具。只检查代码索引入口也不能代表整个渲染层。

## Decision

桌面包的 `npm run typecheck` 依次执行 `typecheck:renderer` 和 `typecheck:main`，两项都使用 strict。生产 `build` 先执行这个入口，再打包。解决方案配置列出两个项目；渲染项目纳入整个 `src`（含测试），主进程沿用 Electron、扩展、CLI 和跨进程共享源码的既有范围。CodeMirror 视图的类型解析跟随渲染打包器的单例；浏览器和 Node 各自保留自己的环境声明。

两项检查使用 `--noEmit`，只把增量记录写入各自的临时目录。显式编译主进程仍遵守[独立输出目录](../bug-fix/2026-11-17-electron-tsc-output-isolation.md)，不在 TypeScript 源码旁留下 JavaScript。

## Alternatives considered

- 只检查改动文件及其依赖，反馈更快，但看不到未被当前页面引用的组件和主进程入口。
- 单靠打包器可直接验证模块导出，不能检查服务签名或防止类的重复方法覆盖；从检查中移除测试则会继续漏掉旧 IPC / SDK 夹具。

## Consequences

新增的类型错误会在打包前阻止构建，可在桌面包单独运行其中一侧定位。测试替身按使用的端口建模而不依赖服务私有成员。已删除的 TencentDB 服务不再保留无法加载的启动测试；仍存在的父进程守卫用真实子进程和管道断开覆盖。

## Verification

在桌面包运行 `npm run build` 通过：两个严格类型检查各从 192 条诊断降至 0，然后实际生成 main、preload 和 renderer 产物。AgentData、IPC、渲染组件和扩展的定向测试通过；[命令、范围与结果](../../../evidence/2026-11-25-desktop-typechecks/REPORT.md)。
