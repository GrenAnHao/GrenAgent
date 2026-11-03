# GrenAgent 品牌接入验证

原稿来自用户明确提供的本地 `grenagent-svg.zip`；ZIP SHA-256 为 `3bd1113ba038ae870be1b3ab2d966e6ebef1c0411f4a73fdbafa6cb1dcb077e5`。六份源文件逐字节匹配，见 `source-hashes.json`。

最终范围：顶部保留原纯文字 GrenAgent；欢迎页、浏览器新页、进程退出错误态、网络/DNS/证书错误文档采用原稿 G；启动屏使用完整路径 Logo；生成系统与 favicon 的 PNG/ICO/ICNS。无原生托盘/独立关于页可替换。

验证记录：

- 定向 Vitest 8 文件 75 项通过，见 `final-unit.log`；用户要求顶部恢复纯文字后，标题栏 5 项重新验证通过，见 `titlebar-text-green.log`。红灯日志保留以证明旧图形和遗漏 guest 错误页可被检查抓到。
- `npm run icons` 成功，二次生成哈希一致，见 `icons.log` 与 `icons-idempotence.log`。
- 品牌组件与浏览器错误文档定向 TypeScript 检查通过（正常无输出，exit 0）；`electron-vite build` 通过，见 `brand-typecheck.log` / `bundle.log`。Vite 已有动态导入警告保留在日志中。
- 完整 `npm run build` 未通过：RepoWiki App.tsx:2095、2531 的两个导航函数未定义，见 `build.log`。这些文件未由本次品牌任务修改。
- 最新 `brand-assets`：68 通过 / 0 失败，见 `brand-assets-user-correction-final.log`。顶部纯文字、原稿几何、明暗/小尺寸和真实生成的 guest 错误文档均覆盖。只跑本次两个相关 UI 场景，其余 43/45 场景未运行。
- `workbench-layout`：244 通过 / 0 失败，最新顶部恢复后的结果见 `workbench-layout-final.log`。
- 启动屏截图直接加载产品 index.html，阻止模块和外网脚本以保留首帧，使用独立 Electron 数据目录。检查主题、完整路径与画布后捕获；未启动正式应用。
- 原始源文件逐字节核验、UI 页面零异常。已有 Node localstorage 与 Electron pak/cache 警告保留在日志中。
- `npm run verify-notes` 通过：147 篇笔记的目录、格式与链接，1 份归档封印与证据门禁通过；6 条其他旧笔记的非阻断警告保留，见 `verify-notes.log`。

截图：`brand-assets-dark.png`、`brand-assets-light.png`、`brand-assets-narrow-light.png`、`brand-assets-guest-error.png`、`boot-dark.png`、`boot-light.png`，以及最终工作台空会话深浅截图。

限制：未生成/安装安装包，macOS/Linux 原生图标未实机验证。运行中的窗口图标需重启应用，任务栏/快捷方式图标可能需重新安装并等待系统缓存刷新。未提交、推送或调用模型。
