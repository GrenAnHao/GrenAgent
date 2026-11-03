# 会话链接打开文件管理器修复

截图中的异常已复现并修复。原始 Windows Markdown 链接采用 `/D:/...`，旧解析器将它作为 POSIX 绝对路径，误把 `/D:/.../docs` 用作新 workspace；主进程 realpath 随后报 `workspace path does not exist`。目标文件实际存在。

生产修改仅在 `electron-agent/src/lib/hrefKinds.ts`：链接解码和斜杠统一后，将明确的 `/盘符:/` 恢复为 `盘符:/`；对编码盘符也重新识别绝对路径。会话正文和文件预览共用该修复。普通 POSIX 路径、外链和项目边界规则保持原有行为。

验证：

- 修复前 5 条单测失败：[vitest-red.txt](vitest-red.txt)。
- 修复前真实 Electron 场景重现相同 workspace 错误，3 条失败：[ui-red.txt](ui-red.txt)、[截图](chat-link-broken.png)。
- 修复后相关单测 5 文件、52 项通过：[vitest-green.txt](vitest-green.txt)。
- 修复后真实 Electron 的 chat-file-links 场景 26 条断言全部通过：[ui-green.txt](ui-green.txt)。实际点击文档和图片链接，覆盖文件预览内链、编码盘符、重复点击、重挂载、缺失文件后恢复及浅色主题。文件 IPC 均使用正确项目根。
- 只运行本次 UI 场景 1/35，其余 34 个未运行。

[修复后截图](chat-link-light.png)。桥桩严格检查 workspace，不在测试中替错误路径纠错。

已打开的旧错误标签不做自动迁移。加载修复后的前端后，关闭旧错误标签并重新点击原会话链接即可；原消息与磁盘文件不需要更改。
