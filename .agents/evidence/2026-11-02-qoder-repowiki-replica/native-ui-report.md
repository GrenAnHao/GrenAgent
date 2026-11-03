# Native Wiki UI / contract 交付

- `packages/contracts/src/native.ts` 定义 renderer-safe request/response、author storage token CAS、slug 约束与 validator；`index.ts` 注册独立 native action，不改变旧 action 所需字段。
- `workspace/NativeWikiPanel.tsx` 提供显式 native 入口、状态/覆盖/投影、作者配置保存与显式转换、prepare 与外发确认、暂停/取消、草稿和投影修复。返回原阅读器仍通过原项目 namespace 和编辑入口。
- `workspace/Markdown.tsx` 在显式 native 阅读下识别仓库相对 file 引用，并拒绝绝对、反斜杠、父目录、异常范围等；无效引用为不可定位文本，后端找不到时沿现有源码窗口报错。
- 新增 `contracts/src/native.test.ts`、`ui-harness/scenarios/repo-wiki-native.tsx` 和同名 probe；旧工作区文件修改前备份在 `ui-preimage/`。没有执行这些用例。

## 用户人工检查

在确认构建和模型费用后，用 `cd electron-agent && npm run ui:check -- repo-wiki-native --show` 运行定向 UI probe；查看深浅主题和窄窗口截图，并核对 native 模型确认、partial 覆盖、作者保存 token 和危险链接。真实项目验收须先核对 actual engine/build、授权模型、项目/分支/locale/提交与预算；显式 full 后查看页面，人工构造 partial 再 repair 和 update，确认旧正文/草稿与投影状态。后端注册、文件投影和实际模型由主代理/服务 owner 交付，桩不证明它们已运行。

本轮未运行测试、类型检查、构建、UI、应用或模型；视觉与端到端效果未验收。
