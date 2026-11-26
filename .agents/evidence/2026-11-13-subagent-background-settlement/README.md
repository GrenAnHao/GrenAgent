# 子代理后台 Bash 收尾验收

- [baseline.txt](baseline.txt)：可控时钟让旧实现把正常回复后的子代理写成 `stuck: no activity for >300s`，新增回归断言失败。
- [final-runtime.txt](final-runtime.txt)：11 个定向测试文件，391 项通过。覆盖按 owner 和 job 实例裁决、并发命令有输出、自然退出先于裁决、停止失败、用户先停、10 秒未确认、迟到回执、主动取消与后续轮次失败。
- [windows-sdk.txt](windows-sdk.txt)：Windows 上的真实 Pi SDK 会话使用本地流式模型夹具，实际调用 Git Bash。超时场景在确认前核对 Bash 父子进程存活，确认后两者消失，旁路进程仍存活；有持续输出的命令自然完成。读取真实临时 SQLite，核对列表、父通知和等待方；共 18 项通过。未请求外部模型或访问用户会话。
- [ui.txt](ui.txt)：真实 Electron 的 `subagent-detached`（29 项）、`task-notices`（40 项）通过，检查等待、超时、完整回复和命令级停止结果。见同目录的三张截图。

本机有 Git 忽略的旧 JS 产物和 TS 源码同名。运行 Vitest 时使用同目录 `source-first.mjs` 作临时配置（`--config <该文件路径>`），避免测试意外加载旧文件；不改动原产物。Windows Git Bash 实跑可用 `PI_TEST_GIT_BASH` 指定本机 Bash 的绝对路径。
