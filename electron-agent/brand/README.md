# GrenAgent 品牌素材

`source/` 保存用户批准的原始设计文件，不要覆盖或重绘这些文件：

| 文件 | 用途 |
| --- | --- |
| `grenagent-logo.svg` | 完整横版 Logo，G 图标与路径字标，透明背景，`currentColor` |
| `grenagent-icon.svg` | 独立 G 图标，352 × 352 画布，透明背景，`currentColor` |
| `grenagent-logo-white.svg` | 固定白色完整 Logo |
| `grenagent-icon-white.svg` | 固定白色独立图标 |
| `grenagent-preview.png` | 用户批准原稿的设计预览 |
| `README.txt` | 原始素材包说明 |

原始 ZIP：`grenagent-svg.zip`，SHA-256：
`3bd1113ba038ae870be1b3ab2d966e6ebef1c0411f4a73fdbafa6cb1dcb077e5`。

界面通过 `src/components/GrenAgentLogo.tsx` 内联可信原稿，不依赖字体，也不使用预览 PNG 替代 SVG。`GrenAgentLogo` 用完整横版原稿，`GrenAgentIcon` 用独立图标。两者按工作台中性前景色适配明暗；重复在项目文字旁出现的装饰图标设为 `aria-hidden`。原稿通过 `<img>` 引用时不会继承外层 `color`，深底可使用固定白色版本。

从仓库根目录运行：

```sh
pnpm --dir electron-agent icons
```

生成器读取原稿，更新启动屏标记块，并生成 `build/icon.svg`、1024px `build/icon.png`、多层 `build/icon.ico`（16/24/32/48/64/128/256）、`build/icon.icns` 和 `public/favicon.ico/png`。系统派生图标采用深色圆角底和白色 G，以适应任意桌面背景；16/24px 只扩大图形占比，保留原稿路径。派生资源入仓，打包不隐式重跑生成器。

界面开发版本需重新构建/加载后看到新图形；运行中的窗口图标需重启应用，已安装程序的任务栏与快捷方式图标需重新打包/安装，操作系统也可能缓存旧图标。
