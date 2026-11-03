# 旧 v2 content 链接故障

## 只读定位

- 用户报错：`INVALID_PAGE_LINK: page architecture; target ../content/modules/pocock/categories.md`。
- 任务：`2323a612-8c9f-4c1d-b20e-55a814a5a2a2`，pipeline `knowledge-kernel-qoder-v2`，不是 native `qoder-wiki-local-v1`。
- 项目：`D:/System Dir/Downloads/note-pocock-flow`。实际数据位于 `%APPDATA%/electron-agent/agent-data.db`，本轮仅只读 SELECT。
- 2026-11-02 23:23:22 创建，`generate:architecture` 23:27:12 保存 failed candidate，23:29:00 任务终态失败。planned 14 / prepared 2 / failed 1 / blocked 11 / published 0。
- 候选正文 18250 字符、103 条 evidence 已保存。目标不在源码 manifest 或该页 Read 证据中，但冻结计划有 Wiki 页 `modules/pocock/categories`。
- 运行宿主为 `electron-agent/out/main/repo-wiki-host.cjs`。本轮不构建、重启、重试或操作真实任务。

## 根因与修复合同

顶层 `architecture` 的 Wiki 虚拟目录为空；普通路径解析遇首个 `..` 返回 invalid，旧规范化跳过该目标，最终硬校验报错。此处应按已知页面身份处理，不应认作源码读取，也不是允许任意越根路径。

仅精确匹配冻结 pageIds 的 `../content/<pageId>.md` 普通导航转为 canonical Wiki 相对链接；保留已正常匹配的 Wiki 链接优先级。不增加来源、文件权限或必需页面；未命中别名时保留原源码验证、未知导航降级与越根拒绝规则，不放行 source 引用、行号来源、绝对路径或其他 traversal。

## 静态材料与人工步骤

- `knowledgeKernel/validation.test.ts`：精确案例及编码、锚点、引用式定义、已知页优先和非法目标边界。
- `knowledgeProcess/projectPort.test.ts`：在不具备该源码文件的条件下，根据冻结目录发布 canonical 导航，保留 raw 输入及真实来源、走原 publication 收据。
- `KnowledgeKernelCoordinator.reuseFailedCandidate()` 已有相同输入/依赖/来源证据校验后本地重新规范化候选的路径；本次没有触发它或改变预算。
- 仅成功匹配别名才跳过来源推断；有冻结目录但未匹配别名时，已验证的真实 `content/*.md` 源码仍沿原合同规范化。canonical 计算先分离目标文件名，避免父目录同名 Wiki 页被错误转成 `.md`；`#` 后的 `?` 仍属于锚点，保留完整编码。
- 独立 Sol 静态审查见 [review.md](./review.md)，发现的来源兼容、fixture 来源字段和相对路径边界已回修；当前审查范围无未解决的确定问题。

以上用例均未执行。用户更新构建后，可先手动运行两组定向用例；需要继续真实生成时选择原任务的修复入口，冻结输入仍匹配时可复用候选，剩余未完成页面仍可能产生模型费用。当前应用是否载入新修复由用户自行确认，不把源码修改当成运行成功。
