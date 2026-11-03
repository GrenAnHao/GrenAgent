# Agent Note: 会话文件链接的 Windows 盘符前缀归一化

Status: implemented

## Problem

用户点击会话正文的 `/D:/OneDrive/Project Files/Pi/.../README.md` 链接，文件管理器报 `workspace path does not exist`。classifyHref 保留盘符前的斜杠，resolveSessionFile 无法将它归到真实的 D:/ 项目根，而将 `/D:/...` 的父目录作为新 workspace；主进程 realpath 拒绝。交付卡传 D:/ 原生路径不受同一入口影响。

## Decision

共享链接分类入口在完成百分号解码及斜杠转换后，将严格匹配 `/盘符:/` 的路径恢复为 `盘符:/`，并基于解码后的路径判断绝对路径。会话链接与文件预览链接共用同一规则，保留 POSIX 根路径、协议分流、query/hash 处理和主进程越界校验。生产改动仅位于 hrefKinds.ts，不更改文件服务或 dock 身份逻辑。

相关旧笔记：[文件管理器链接](../../implemented/feature/2026-10-23-file-explorer-casual-links-and-paths.md) 部分重叠，保留导航拦截与项目内链接约束；[会话 cwd 文件解析](../../implemented/bug-fix/2026-10-16-session-cwd-file-paths.md) 部分重叠，保留 root 选择规则。本次是链接输入格式兼容，不更改磁盘路径或沙箱权限。

## Alternatives considered

- 只修改助手生成的链接：可以立刻规避新消息，但已经发出的会话与第三方 Markdown 仍会触发，不能作为产品修复。
- 主进程 realpath 失败后试着去掉斜杠：所有读盘入口都能兜底，但掩盖错误来源、影响非链接调用，且预览中的路径比较已经在主进程前走错，不采用。
- 在 resolveSessionFile 里统一剥离所有前导斜杠：可覆盖这个现场，但会破坏 POSIX 绝对路径，因此只在链接入口识别明确的 Windows 盘符形状。

## Consequences

与截图相同的含空格 Windows 链接，经真实 AppLinkGuard → routeAppLink → openWorkspaceFile → FileTreeBody 能列出正确项目根并预览目标文件；编码盘符正确识别；重复点击复用正确面板；图片链接能预览；普通 POSIX 根路径和外链不变；文件预览仍拒绝项目外 Windows 路径。

兼容范围严格限定 `/[A-Za-z]:/`，不能把普通 `/docs` 当 Windows 路径，也不能把 file:、未知协议或路径穿越变为可访问路径。已落盘的错误 workspace 不做迁移；加载修复后的前端后，关闭旧错误标签并重新点击原链接可用正确根打开，不需要修改会话消息或文件路径。

## 验证

证据目录：`.agents/evidence/2026-10-28-windows-chat-file-links/`。

- 真实磁盘检查：用户所点 README 与 D:/ 项目根均存在，错误的 /D:/ 父目录不存在，见 filesystem-check.txt。
- test-driven-development 红灯：`cd electron-agent && npx vitest run src/lib/hrefKinds.test.ts src/features/links/AppLinkGuard.test.tsx`，5 项预期失败，见 vitest-red.txt。
- electron-ui-harness 技能新增 chat-file-links，使用真实 Markdown 和真实链接入口、FileTreeBody，桥严格拒绝错误 workspace。修复前 `npm run ui:check -- chat-file-links` 重现 `/D:/Link Workspace/Pi/docs` 错误根和 workspace path does not exist，3 条预期失败，见 ui-red.txt、chat-link-broken.png。
- 修复后 `npx vitest run src/lib/hrefKinds.test.ts src/features/links src/features/fileExplorer/markdownLinks.test.ts src/features/chat/sessionCwd.test.ts src/features/dock/openWorkspaceFile.test.ts`：5 文件 52 项通过，见 vitest-green.txt。含 POSIX、外链、未知协议、query/hash、编码盘符及项目边界回归。
- 修复后 `npm run ui:check -- chat-file-links`：26 条断言全部通过，见 ui-green.txt；覆盖实际点击文档/图片、文件预览内链、重复点击、恢复、缺失文件后重新打开、浅色主题及所有文件 IPC 的根参数。只运行本次场景 1/35，其余 34 个场景未运行。截图 chat-link-opened.png、chat-link-light.png。
- `npm run verify-notes` 检查树、格式、归档及验证证据；结果见 verify-notes.txt。
