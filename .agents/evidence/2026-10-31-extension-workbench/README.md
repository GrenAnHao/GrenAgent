# 扩展页分栏工作台验证

用户确认的四页布局已落地。验证只覆盖本次扩展模块与必要文件选择桥，没有运行全项目单测或全部 UI 场景。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 扩展模块 + runtime / preload / IPC 定向单测 | 17 文件、128 项通过 | `unit-green.log` |
| 真实 Electron 四页集成 | 118 项通过 | `ui-green.log` |
| 命令与规则既有编辑交互 | 29 项通过 | `ui-green.log` |
| 生产构建 | `npx electron-vite build` 通过 | `build.log` |
| 定向 renderer 类型检查 | 两处既有 TS2352，修改文件无新增错误 | `renderer-types-final.log` |

UI 只运行 `extensions-workbench` 和 `prompt-library-panel` 两个场景（2/43），包含明暗、实际列宽变化、同 DOM 草稿、MCP 权限/参数规则/配置来源/重载、技能新增和三种导入、删除确认与短窗可达性。`affected-ui.log` 中全量影响源自工作区此前已有的主题等改动，没有据此扩大范围。

截图来自真实组件及确定性内存桥：`mcp-light.png`、`skills-light.png`、`commands-light.png`、`rules-light.png`。这些不代表真实远端 MCP 或原生文件对话框的人工验收。

红绿记录保留在 `command-rules-*`、`mcp-*` 和 `skill-picker-*` 日志。`ui-first.log` 的新 probe 第二项技能 ID 写错导致中止，`ui-third.log` 的文件参数断言误写为 `path`（真实协议为 `src`）；均修正测试后运行最终场景。`ui-before-polish.log` 已有 146 项通过，最终增加命令目录中性主题断言后为 147 项通过。

`renderer-types-final.log` 中仅有未修改的 `src/features/extensions/mcpConfig.ts:137/145` 两处原有 Record 转 McpConfig 类型转换错误。检查所用临时 tsconfig 已移除。生产构建由 Electron-Vite 完成，不声称全仓 TypeScript 检查通过。

`preexisting.patch` 保存本次开始前命令/规则与旧 prompt harness 的相关未提交改动，供区分既有工作与本次变化。没有提交、推送或发版。
