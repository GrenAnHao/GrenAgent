# native 概览的界面回修

## 用户观察与原因

用户提供的真实截图见 `user-observed.png`：右侧主概览是贴左的原生 HTML 表单，预算字段和所有动作同时展开。`NativeWikiPanel.tsx` 当时只有少量 inline style，没有使用既有居中概览/状态卡，普通按钮又被根 reset 去掉背景与边框。不是整个应用 CSS 丢失：同一截图中的导航和侧栏仍正常。

## 本次修改

- native 的 RPC、确认、轮询、任务/发布刷新与生命周期保持原接线。
- 复用 `rw-generation-overview`、`rw-overview-cluster`、图标与 `rw-state-card`；控件改用既有 antd，沿用宿主森林绿主题。
- 主按钮按 native 状态显示首次生成/增量/失败修复/继续；运行时为暂停及取消，其他生成动作仍可在更多菜单找到，不发送任何隐式请求。
- 费用限制、作者 JSON 和运行诊断折叠到生成设置。发布数/失败数、partial、可读数、投影状态分别展示，真实错误仍可见；确认继续保留模型/引擎/目标/作者版本/scope/预算信息。
- 新 CSS 只作用于 `.native-wiki-panel`，没有更改全局 reset、其他组件或后端数据。

## 用例与证据边界

修改前源码在 `preimage/`。先更新 `repo-wiki-primary` 的居中、主按钮尺寸/颜色、默认一项动作、折叠/展开、窄窗和截图 probe，再改产品实现；既有 `repo-wiki`/`repo-wiki-native` probe 与 `RepoWikiWorkspace.test.tsx` 的语言/更多菜单/设置入口同步。

本次仅主代理静态阅读和修改。没有执行用例、类型检查、构建、UI harness、应用重启、目标函数、模型或付费生成；没有生成回修后的运行截图。`repo-wiki-primary` 中的截图与断言是供用户手动执行的代码，不是通过证据。上一轮 Sol 审查只覆盖当时的主入口/生命周期接线，不当作本次布局的视觉证据。

人工载入后重点确认：布局居中、主按钮可识别、首次生成不要求填预算/JSON；展开设置和更多菜单仍能完成配置及原有动作；切页不影响后台任务。步骤见 `docs/repo-wiki-native-manual.md`。
