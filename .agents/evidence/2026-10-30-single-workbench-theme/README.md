# 单一工作台主题与对齐验证

- `unit-final.log`：6 文件、65 项定向组件/状态测试通过。
- `theme-store-red.log`、`appearance-settings-red.log`、`vitest-composer-width-red.log`：旧配色恢复、颜色选项和消息列宽的有效红灯；对应绿色日志与最终结果保留。
- `ui-final.log`：统一配色、输入宽度与外观设置的两个相关场景通过。
- `ui-workbench-final.log`：最终图标栏比例与无竖条版本，62 项通过。
- `ui-workbench-narrow.log`：图标栏进一步从 64px 收窄至 52px 的当前版本，62 项通过；`workbench-narrow-52-light.png` 为对应实际截图。
- `ui-workbench-compact-buttons.log`：当前比例为栏宽 52px、按钮 36px、图标 18px，62 项通过；实际截图为 `workbench-compact-buttons-light.png`。
- `ui-workbench-surface-hierarchy.log`：最新背景分层版本，75 项通过；标题栏与图标栏同色，会话列表与聊天区分层，浅深截图为 `surface-hierarchy-light.png` / `surface-hierarchy-dark.png`。`affected-surface-hierarchy.log` 仅做影响分析，没有运行全量场景。
- `ui-appearance-settings.log`：外观设置真实主题/系统变化/字号/弹层/持久化，33 项通过。
- `workbench-layout-*.png` 与 `appearance-settings-*.png`：真实组件截图；宿主读写为桩。

未运行全量 UI 场景或打包安装验证。
