---
title: Cursor 的删除、抓取、后台命令和诊断走会话工具
status: superseded
date: 2026-10-07
scope: cli
files:
  - cli/src/cursor/exec-handlers.ts
  - cli/src/cursor/vendor/providers/cursor.ts
  - cli/src/cursor/exec-bridge.test.ts
supersedes:
superseded_by: cli/2026-10-07-remove-cursor-provider.md
---

> 已过时 → 见 [2026-10-07-remove-cursor-provider.md](2026-10-07-remove-cursor-provider.md)

## 背景
删除、打开网页、后台启动命令、读诊断这四类 exec 帧在桥上没有对应的会话工具。删除和诊断回 `Tool not available`，抓取和后台启动写死 `Not implemented`，模型会换一条路重试或把这一轮做砸。交互式标准输入同样写死 `Not implemented`，模型不知道该改用一次性命令。

## 决定
- 删除帧：路径必须落在会话目录里，且不能是会话目录本身。会话有 `delete` 工具就用它；否则走 `bash`，命令是带引号的 `Remove-Item -LiteralPath`（Windows）或 `rm -f --`。两条都经过 `beforeToolCall`。
- 抓取帧：调用会话的 `fetch_url`，把工具正文写成 Cursor 的 `FetchSuccess.content`。没有这个工具时回「fetch_url 不可用」。
- 后台启动帧：调用同一个 `shell` handler，并带上 `run_in_background: true`。成功时 proto 没有 stdout，job id 写在 `command` 的第二行，`shellId` 取 job id 末尾的数字。拒绝类文案回 `rejected`，其它失败回 `error`。
- 诊断帧：会话有 `lsp` 就调用它；没有就直接回成功、诊断条数为 0，正文说明没有语言服务。
- 写标准输入：错误文案改为要求改用一次性命令，不要写后台 shell。

## 放弃的方案
- 改接 `@cursor/sdk`：登录、沙箱和现有工具卡片都要换掉，这次只把现有客户端上缺的帧补上。
- 删除直接 `fs.rm`：不经过 `beforeToolCall` 和沙箱。
- 后台启动继续回 `Not implemented`：模型会改在前台再跑一遍，或反复重试。
- 把 job id 只留在界面卡片：同一轮里模型读到的是 exec 结果，proto 的成功消息没有 stdout，不写进 `command` 它就看不到 id。
- 没有语言服务时回 `Tool not available`：模型会当成暂时失败再要一次。

## 后果
没有 `delete` 工具时，卡片名是 `bash`，摘要是 `Delete 文件名`。诊断条数为 0 只表示没有语言服务，不表示文件没有问题。`shellId` 不是 `job_output` 用的字符串 id，模型应读 `command` 第二行的 `job …`。`shellStream` 仍是命令结束后一次交回输出。
