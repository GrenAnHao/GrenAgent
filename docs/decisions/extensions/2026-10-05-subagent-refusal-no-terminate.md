---
title: 子代理里 safety 拒绝不再 terminate，只读判定去掉误报，空输出写明停在哪
status: active
date: 2026-10-05
scope: extensions
files:
  - extensions/safety/index.ts
  - extensions/safety/rules.ts
  - extensions/multi-agent/assistant-output.ts
  - extensions/multi-agent/embedded-runner.ts
  - extensions/multi-agent/index.ts
supersedes:
superseded_by:
---

## 背景

子代理跑到一半以 `sub-agent failed (exit 1): (no output)` 退出。扫了近 21 天 418 个子代理会话：失败里最多的一类（38 个）是会话停在一条被 safety 拦下的工具结果上，其中 33 个是只读档的 `bash` 被判「会改动文件系统」。`refuse()` 一律带 `terminate`，本批工具后不再调模型，子代理没有最终答复，父代理只拿到 `(no output)`，前面几十步的工作全丢。被拦的命令里约一半是误报：`> $null` / `2>$null` 当成写文件，`git merge-base`、`git stash list`、字符串 `"diff-vs-commit"` 命中 git 改动词。模型报错（503、上游断流）时 `errorMessage` 也被丢掉，同样只报 `(no output)`。

## 决定

`refuse()` 在 `resolveToolOrigin() === "subagent"` 时只 block、不 terminate，原因后面补一句「不要原样重试，换不受限的办法继续；做不到就在最终答复里说明」。主会话照旧 terminate。

`isMutatingBash` 去掉误报：丢到 `$null` / `/dev/null` / `NUL` 的重定向不算写盘；词边界把 `-` 算进词里；git 只在子命令位置匹配（允许前面带 `-C <路径>`、`-c k=v`、`--flag`）；`git stash list|show` 放行。顺手补上 `switch`、`pull`、`cherry-pick`、`revert`。用真实会话里 3293 条子代理 bash 命令回放：新规则没有多拦任何一条，原来被只读档拦下的 41 条里 18 条放行，剩下 23 条都是真的写文件（重定向到 `$env:TEMP`、here-string 落临时文件）。

一次性嵌入式子代理没有最终答复时，`error` 写停下的原因：最后一条 assistant 是模型报错就给 `model error: <首行>`；停在工具结果上就给 `stopped after <工具> without a final reply[: <报错首行>]`。都不是才回退 `(no output)`。部分产出的提示从「超时截断」改成「未正常结束」，因为模型报错也会走这条路径。

## 放弃的方案

- 全局去掉 terminate：主会话里 terminate 的用意是把决定交还给用户，子代理没有用户，问题只出在子代理。
- 保留 terminate，嵌入式 runner 在停在 toolUse 时追加一轮「总结已有结论」：每次多一轮调用，并且被拦的那一步本来可以换路做完，没必要先停再补。
- 只读档放行写 `$env:TEMP` 的重定向：剩下 23 条大多属于这类，但这是放宽只读边界，需要单独决定；不 terminate 之后模型会改用管道，代价只是一次被拦的调用。
- 把引号内容整体抹掉再匹配命令词：`pwsh -c "rm x"` 这类会漏判，只读档没有 OS 层兜底，宁可留一点误报。

## 后果

子代理被拦后会继续跑，可能反复尝试别的写法；同一调用的重复靠 loop-guard 兜底，空转靠空闲 / 硬超时。git 子命令定位依赖正则识别全局参数，未列出的带值参数（如 `--namespace x`）后面的子命令会漏判。若以后子代理有了可交还的人（例如审批面板接管子代理），需要重新评估子代理里是否恢复 terminate。
