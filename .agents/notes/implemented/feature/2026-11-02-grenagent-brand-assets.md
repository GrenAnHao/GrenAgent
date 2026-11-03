# Agent Note: GrenAgent 原始品牌素材与应用入口统一

Status: implemented

## Problem

用户已批准黑白几何 G 图标和路径化 GrenAgent 横版 Logo，并要求把设计原稿放入项目、替换品牌入口。欢迎页、浏览器和启动屏原来使用 π；系统图标生成器也硬编码 π 的形状与颜色，直接换 SVG 会留下旧资源。

## Decision

`electron-agent/brand/source/` 保存用户本地 ZIP 中的四份 SVG、预览图和说明，保持字节不变。ZIP SHA-256 为 `3bd1113ba038ae870be1b3ab2d966e6ebef1c0411f4a73fdbafa6cb1dcb077e5`。欢迎页和浏览器使用原稿 G，启动屏使用原稿横版 Logo，不重绘、不依赖字体；界面以中性前景色适配明暗。用户查看实际界面后明确要求顶部不替换，因此标题栏保留原来的纯文字 GrenAgent，不放图形 Logo。系统 PNG/ICO/ICNS 与 favicon 使用同一 G，深色圆角底保持跨桌面背景的辨识度，小尺寸仅调整留白，不改几何。

原始文件是唯一设计来源。现有手动 `npm run icons` 生成所有派生资源和启动屏品牌片段，保留多分辨率 ICO；不新增依赖。窗口运行时按平台选择相应图标并确保打包资源可读取。不改 appId、产品名、签名、更新或部署配置。没有原生托盘或关于页，不新增入口。

浏览器有两条错误显示路径：网页进程退出时使用 React `BrowserErrorState`，连接/DNS/证书加载失败时使用 `browserErrorPageUrl()` 生成的独立 guest HTML；两者都引用原稿 G。后者保留原文档配色与错误行为，仅将品牌设为中性前景并停止旧的图标旋转，保持 G 正向。

## Related notes

检索品牌、Logo、图标、PiBrandLogo 与生成器后，没有同主题旧笔记或否决方案。[专业工作台](../../implemented/feature/2026-10-30-professional-workbench.md) 与[单一工作台主题](../../implemented/simplification/2026-10-30-single-workbench-theme.md) 部分重叠；保留其布局、主题及输入生命周期约束，仅更新品牌图形。

## Alternatives considered

- 把 SVG 当 `<img>` 直接引用最简单，也完整保留原稿；但 `currentColor` 不会继承宿主颜色。界面采用内联可信原稿内容，保留所有路径与变换，使明暗主题不会出现黑色图形落在深底上的问题。
- 只覆盖现有 PNG/ICO 能最快更新安装图标；但会丢失生成方式并让 π 的生成器在下次运行时覆盖新图标，因此同步替换生成源和生成器。
- 透明单色 G 最贴近原稿，适合界面；系统桌面背景不可控，因此系统与 favicon 派生资源使用深底白 G，而原稿继续保持透明。
- 标题栏放完整横版 Logo 能统一所有入口；用户查看实际界面后明确拒绝顶部图形，因此标题栏恢复原来的字体、字距与两段文字颜色，完整 Logo 只用于启动屏及原稿预览。

## Consequences

- 原稿逐文件哈希与用户 ZIP 相同；欢迎页、浏览器空态/错误态、冷启动和 favicon 都不再使用 π；标题栏保留原纯文字。
- PNG/ICO/ICNS 与 favicon 可以复现生成，格式、层尺寸与原稿几何由定向检查覆盖；平台运行时与打包清单使用一致的资源路径。
- 在隔离 Electron harness 中验证真实品牌组件、标题栏、空会话和浏览器入口的明暗、小尺寸与窄屏，并保留截图。
- 原稿与派生文件均需维护，改原稿后应手动运行生成器；小尺寸阶梯细节会减少，16/24px 的系统图标扩大了图形占比，但不另绘小图标。
- 不提交、不推送、不调用模型、不重启用户正式应用。macOS/Linux 原生窗口及安装包效果不能在当前 Windows 主机完整验证；运行中窗口与安装快捷方式需重启或重新打包后生效。

## Verification

定向 Vitest 75 项通过（8 文件），其中标题栏 5 项按用户最新要求恢复纯文字后复验；guest 错误页先观察旧 π 的单测与真实 HTML 预览失败，再修复。`npm run icons` 成功，二次生成的六份派生资源与 index.html 哈希一致；六份源文件逐字节匹配用户 ZIP。`brand-assets` 与 `workbench-layout` 只运行本次相关场景，其余场景未运行。品牌组件定向类型检查、`electron-vite build` 与启动屏深浅首帧预览单独执行。

完整 `npm run build` 未通过：在 RepoWiki 类型检查被既有 `vendor/repo-wiki/apps/web/src/App.tsx:2095` 的 `navigateFromMarkdown` 和 `:2531` 的 `navigateDraftFromMarkdown` 未定义错误阻塞；没有修改用户的该模块。生产 bundle 单独构建，不能把它等同于完整 npm build 通过，也未生成安装包。

日志、截图及原稿哈希归入 `.agents/evidence/2026-11-02-grenagent-brand-assets/`，最终场景计数与笔记校验见证据 README。所有 UI 预览使用隔离离屏 Electron，没有启动正式应用或外部模型。已有 Node localstorage、Electron pak 与 Vite dynamic-import 警告如实保留在日志中。

最终 `brand-assets` 68/68、`workbench-layout` 244/244 通过；其余 43 个 UI 场景未运行。`npm run verify-notes` 通过：147 篇笔记的目录、格式与链接，1 份归档封印及证据门禁均通过；6 条其他旧笔记的非阻断结果警告未修改。
