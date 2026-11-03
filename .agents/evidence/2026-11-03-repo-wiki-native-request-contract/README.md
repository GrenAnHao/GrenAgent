# 首次生成的公开请求校验冲突

## 证据

`user-observed.png` 为用户当前截图，状态为未生成/已发布 0 篇，显示 `Unexpected request property`。修改前源码在 `preimage/`。

静态调用链：`NativeWikiPanel.prepare` → 默认配置 `author.save(expected_storage_token)` → `createGrenRepoWikiClient.invoke` → 公共 `validateRequest('native', input)`。作者配置已保存时，接下来的 `prepare(spending_policy)` 也经过相同入口。渲染适配器在转发 IPC 前先校验；主进程 `repoWikiService.ts` 也导入同一公共合同。

专用 `validateNativeRequest` 已接受这两个字段，但公共层继续检查的 native 白名单没有它们，因而报截图中的错误。后续旧 CAS 校验还要求 token 为 64 位十六进制，不能接受 native 首次保存所需的空 token。只给白名单补字段会留下第二处错误。

## 修改

- native 命令字段与类型只由专用 validator 判断；移除重复的公共 native 字段表，不绕过专用未知字段检查。
- 公共 action/普通对象/序列化及 8 MiB 保护保留；完成这些保护后才返回 native 分支，避免套旧 token/编辑规则。
- 其他 action 的字段、CAS token 和输入规则不变。
- 补充公开入口所有 native 命令、空/opaque token、空/显式费用策略、真实 renderer adapter 的本地转发、非法字段/费用、大小保护与旧编辑兼容的回归代码。
- 将合同用例收录到既有 Repo Wiki 专用 Vitest 配置。根 main/renderer 配置和 vendor 的 node:test runner 原本不收录 `contracts/src/native.test.ts`；手册给出点名该文件的命令。

## 执行状态

仅静态阅读、定向差分与代码修改，未运行测试、类型检查、构建、应用或任何模型。未改用户任务、数据库、预算或生成成果。新增回归未执行，不能据此宣称第一次生成已经跑通。

用户载入新构建后，先点“首次生成”检查能否到达外发确认即可，不需点击“确认外发并开始”来检查这条边界。完整模型生成仍由用户自行决定。
