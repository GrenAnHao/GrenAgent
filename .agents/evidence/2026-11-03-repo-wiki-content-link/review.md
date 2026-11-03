# 静态复核：旧 v2 content 链接修复

## 结论

当前候选未发现剩余 P1 / P2 问题。相对本目录 `preimage/` 的定向复核发现的两处 P2，均已在当前文件修正：

1. 初版把所有 `../content/*` 都视作 alias 候选，跳过了有冻结 pageIds 时仍合法的 `content/guide.md` manifest + Read 来源转换。现仅成功精确匹配的 alias 跳过来源推断，未知链接回原流程；用例已覆盖此来源回归。
2. 新 publication 用例误要求已发布 `sources` 带 `hash`，与现有落盘 `{path,start_line,end_line}` 合同不符。现按实际字段断言，并检查原 artifact 的正文和来源保持不变。

## 最终两项增量复核

root 发现并交原实现 owner 修复的两个边界，已按当前代码和新增 fixture 静态复核：

- **目标文件名与当前目录同名**：现先取目标 `filename`，只消除 `fromDir` / `toDir` 的共同前缀。`modules/start` → alias `../content/modules.md` 生成 `../modules.md`，不再生成 `.md`；嵌套 `chapters/modules/start` → `chapters/modules` 也生成 `../modules.md`。两条新增 fixture 均检查正文和后续 validation 的接受条件；按现有相对解析合同可还原各自冻结目标。
- **fragment 中的问号**：现 hash 取 `#` 之后的完整片段，再安全编码。`#heading?token=secret` 保留为 `#heading%3Ftoken%3Dsecret`，不再误删问号及后文。`#` 之前的真实 query 仍不进入 canonical 链接；公开诊断继续使用既有 `StageValidationError` 去除 query / hash。原 architecture 链接与来源权限未变。

本轮只复核以上两个 delta，没有重扫既有 caller 或运行目标函数。

## 核对范围与证据

- 实现：`electron-agent/electron/agentData/knowledgeKernel/validation.ts`。
- 定向 fixture：同目录 `validation.test.ts` 和 `electron-agent/electron/knowledgeProcess/projectPort.test.ts`。
- 直接依赖只读核对：`shared/wikiLinks.ts` 的解析合同、`markdownLinks.ts` 的代码示例排除和引用定义编辑去重、`projectPort.ts` 的发布规范化及来源落盘、`coordinator.ts` 的 `reuseFailedCandidate` 接入，以及 vendor engine `get_page` 的返回值。

静态路径表明：先保留普通解析已命中的 Wiki 页；仅一次解码后严格匹配冻结目录的 `../content/<pageId>.md` 生成当前页相对链接。未知目标回原有处理，来源引用、绝对路径、反斜杠和其他越根路径未新增许可；未新增 sources、必需页或文件读取权限。引用定义按 destination 位置去重改写，代码示例由 Markdown AST 排除；成功 alias 在 `#` 之前的 query 不进入 canonical 结果，完整安全 fragment 保留并编码。发布和失败候选修复复用现有消费者。

## 验收边界

本次仅静态阅读与差异检查，未运行测试、tsc、构建、应用、目标函数、模型、真实数据库或任务。用例执行及更新构建后的真实修复入口由用户手动验收。

