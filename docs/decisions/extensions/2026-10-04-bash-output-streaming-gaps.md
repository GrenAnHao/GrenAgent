---
title: bash 输出流式的三处缺口：Python 缓冲、尾部截取管道、每条命令重解析壳
status: active
date: 2026-10-04
scope: extensions
files:
  - extensions/_shared/sandbox/operations.ts
  - extensions/sandbox/bashUiDescription.ts
supersedes:
superseded_by:
---

## 背景
PowerShell 已经按次刷新 stdout，pi 的 bash 工具也会把分片节流后经 `tool_execution_update` 送到界面。实测 PowerShell 自身输出、ping、node 子进程都是逐行到达。用户看到的「跑完才出结果」来自三处：管道上的 Python 整块缓冲到退出；近期会话里约三分之一的 bash 调用以 `| Select-Object -Last N` 或 `| tail` 收尾，这类命令天然要等进程结束才知道哪几行是最后；`resolveShellPath` 每条命令都在主进程里同步起 PowerShell 读注册表 PATH 再跑 where.exe，约 0.4 秒，期间事件循环被卡住。

## 决定
- 子进程环境默认带 `PYTHONUNBUFFERED=1`，调用方已设置时不覆盖。
- 壳路径在 operations 实例里只解析一次；启动报 spawn 错误或解析抛错时丢掉缓存，下一条命令重新解析。
- bash 工具追加一条 promptGuideline：长命令不要接 `Select-Object -Last`、`tail`、`Out-String`。bash 工具本身已经只保留输出尾部，这些管道只会把输出攒到结束。

## 放弃的方案
- 给 bash 换 ConPTY，让所有原生程序都以为自己连着控制台：理由同 2026-10-03 的 AutoFlush 笔记，失败面太大。
- 在 bash 工具里改写命令、剥掉 `| Select-Object -Last`：会改变用户看到的输出和退出码语义，模型也不知道命令被改过。
- 壳路径缓存到进程级全局：多个工作区共享同一扩展进程时没有问题，但测试要注入不同的 resolveShell，按 operations 实例缓存更易隔离。

## 后果
装/卸 pwsh 后，要等缓存的路径启动失败一次才会切换。自行全缓冲的其它原生程序（例如部分 C 运行时的工具）仍然要等它们自己刷新。promptGuideline 只约束模型，用户手动 `!` 命令不受影响。
