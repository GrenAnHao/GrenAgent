---
title: 含空格的技能名在发送时用引号保持成一个 token，并在交给 Pi 之前展开
status: active
date: 2026-09-29
scope: electron-agent/chat
files:
  - electron-agent/src/features/chat/skillCommandText.ts
  - electron-agent/src/features/chat/messageTags.tsx
  - electron-agent/src/features/chat/input/editor/ChatTag/tagText.ts
  - electron-agent/src/features/chat/input/editor/commandPaste.ts
  - electron-agent/electron/agent/expandSkillCommand.ts
  - electron-agent/electron/agent/workspaceHandle.ts
supersedes:
superseded_by:
---

## 背景
技能 frontmatter 的 `name` 可以含空格（例如 `IDA Pro逆向分析`）。选中后芯片上是全名，序列化却是 `/skill:IDA Pro逆向分析`。Pi 的 `_expandSkillCommand` 只取 `/skill:` 后第一个空格前的片段去对技能名，对不上就原样送进模型。气泡解析同样用 `\S+`，于是芯片只剩 `IDA`，其余变成正文。

## 决定
名字含空白或引号时，命令标签序列化成 `/skill:"name"`。气泡和粘贴按这组引号还原全名，参数留在引号外面。

`WorkspaceHandle.prompt` 在调用 `session.prompt` 之前，把这种调用展开成与 Pi 相同的 `<skill name="..." location="...">` 块。不含空白的 `/skill:name` 仍交给 Pi 自己展开。没加引号、但已加载技能里有更长的含空格名字能整段对上时，按最长名字展开，避免手打的 `/skill:IDA Pro逆向分析` 仍被切成 `IDA`。

## 放弃的方案
- 只把气泡正则放宽到吃掉空格：参数和技能名的边界无法区分，用户跟在技能后面的文字会被吞进芯片，而且 Pi 仍然对不上技能。
- 改 `node_modules` 里的 `_expandSkillCommand`：升级 `@earendil-works/pi-coding-agent` 就会丢。
- 让用户改技能名、去掉空格：名字来自 SKILL.md，别的技能同样会再撞上。

## 后果
- 乐观气泡看到的是带引号的短命令，重载会话后看到的是展开后的 `<skill>` 块；两边都渲染成同一枚全名芯片。
- 技能名里的 `"` 会写成 `\"`。编辑器 `getDocument('markdown')` 会再过一遍 remark，反斜杠可能被吃掉，因此名字里带引号的技能不能靠这条路径往返。含空格、不含引号的名字可以。
- 同时存在 `IDA` 和 `IDA Pro逆向分析` 时，未加引号的 `/skill:IDA Pro逆向分析` 会展开较长的那个。要调用短名并带参数，短名后面的参数不能再构成另一个已加载的含空格技能名。
