# RepoWiki 知识模型调度接缝实施报告

2026-10-31。根据已确认的修复前追踪结果，接入**当前生产 WikiService 的同一个全局限流实例**；没有把闲置 TaskQueue / SystemWorkerManager 包装成生产统一调度器。未修改 main.ts、RepoWikiService、vendor、UI 或其他代理的集成测试，未提交、推送或调用付费模型。

## 可供宿主调用的接口

位置：`electron-agent/electron/app/agentDataService.ts:189–216`。

```ts
describeKnowledgeModel(): Promise<string>;
completeKnowledge(input: {
  user: string;
  systemPrompt?: string;
  maxTokens?: number;
  expectedModel?: string;
  expectedConfiguration?: string;
  sourceProjectId?: string;
}, options?: { signal?: AbortSignal }): Promise<string>;
```

两种宿主模式均可用。它们按需启动 AgentData；已取消的请求不会启动宿主。默认 child 模式用三个受信任进程 RPC：

```text
agentdata.knowledge.describe
agentdata.knowledge.complete { requestId, input }
agentdata.knowledge.cancel   { requestId }
```

这些方法没有出现在 extension socket 或 renderer/public admin 的管理表里；测试证实项目 socket 和 `requestAdmin()` 无法调用 completion。

模型端口类型已抽到无运行时依赖的 `electron/agentDataProcess/modelPort.ts`，`assemble.ts` 保持同型 re-export。宿主 helper 可以直接 import type 该纯类型文件，避免类型门禁被无关的 AgentData/CodeGraph 实现闭包扩大。

## 实际路径与行为

```text
RepoWiki host completion callback（根代理接线）
→ AgentDataService.completeKnowledge
→ private agentdata.knowledge.complete RPC
→ AgentDataRuntime.completeKnowledge
→ WikiService.completeKnowledge
→ 此 WikiService 的 globalLlmLimit()
→ CompleteFn(system, user, 'repo-wiki', options)
→ runtime 注入的 completeSimple
→ AgentDataModelPort.complete
→ 已有 main.model.complete / main.model.abort reverse IPC
→ 配置好的 AgentData 模型端口（根代理负责宿主解析）
```

- `wikiEngine/service.ts:404` 新方法和已有 ingest extraction / merge / overview 使用相同 `globalLlmLimit`。它不会在底层再获取第二个名额，避免配置为1时的嵌套限流死锁。
- 在**实际拿到槽位后**检查 expectedModel；排队期间切换模型会报 MODEL_CHANGED，原请求不会发 provider。expectedModel 继续传到宿主模型端口，支持根代理在最终选定真实 model 对象时再做原子校验。
- RepoWiki systemPrompt、user、maxTokens 原样传递；返回原文本，不改成旧 Markdown ingest prompt，也不把 JSON解析为对象。
- `wikiEngine/llm.ts` 的 CompleteFn 只新增可选第四参数，旧三参数回调兼容。现有 LlmClient.chat 现在转发 abortSignal / maxOutputTokens；没有顺便改变 temperature、提示词或输出处理。
- `sourceProjectId` 是受信任宿主传来的关联元数据，此接缝不据此授权、不落独立账本；根代理继续负责项目授权。

## 共享预算与取消生命周期

- `ingest/concurrency.ts` 的刷新器现在更新**同一个 scheduler** 的预算，保留已有 active / queued。旧实现改配置时另建 limiter，可能让新旧并发预算叠加；该问题有先失败后通过的测试。
- 每次访问当前 limiter 时按现有配置读取逻辑刷新 `KNOWLEDGE_LLM_GLOBAL_CONCURRENCY`。增大预算会放行既有等待者；减小不会打断在途调用，但 active 降至新预算前不会再放新请求。FIFO 等待队列由 Wiki ingest 和 RepoWiki共享。
- 排队请求有 AbortSignal监听：取消立即从队列移除并reject，之后不发 provider。
- 执行中的请求把信号继续传到现有反向 main.model.abort。即使 provider 忽略 abort，名额也保留到 provider **真正 settle**，并丢弃取消后的迟到结果。
- `runtime.ts:337–356` 用 requestId 跟踪新知识请求的 AbortController；completePromise 未 settle 前 inFlight 不减。close 会取消全部新知识请求，等其真实结束才关存储，避免假完成或提前让下一调用占槽。
- 没有引入自动重试或持久化回放。进程退出后这些请求随原 owner 结束，不会被 TaskQueue.recoverRunning 重新外发。

现有 `CompleteOptions.onUsage` 与 AgentDataModelPort 的 reverse usage 能力保持可传递；本次按明确范围没有另写 service_tasks 账本。旧 Wiki 本来就没有统一短调用用量账本，不能宣称此次已经进入主交互 usage-ledger 或统一费用面板。

## 本代理改动文件

生产：

- `electron/app/agentDataService.ts`：两模式 facade，signal → 私有 cancel IPC。
- `electron/agentDataProcess/{contract,host,assemble}.ts`：三个私有方法、入参边界检查、describe/complete装配。
- `electron/agentDataProcess/modelPort.ts`：新增纯类型端口（assemble re-export）。
- `electron/agentData/runtime.ts`：新知识入口、请求跟踪、退出取消和drain；保留既有无关改动。
- `electron/agentData/wikiEngine/{service,llm}.ts`：共享生产 limiter，原样 prompt，第四参数信号/上限透传。
- `electron/agentData/wikiEngine/ingest/concurrency.ts`：稳定动态预算、排队取消、实际settle前持槽。

测试：

- 新增 `electron/agentData/knowledgeCompletion.test.ts`：真实Runtime + Service + WikiService ingest竞争同一槽，模型切换、动态并发、排队/在途取消、忽略abort持槽、退出等待。
- 新增 `electron/agentData/wikiEngine/llm.test.ts`：旧label与新signal/maxTokens契约。
- 更新 `electron/agentData/wikiEngine/ingest/concurrency.test.ts`：运行中改预算不丢active和queued。
- 更新 `electron/agentDataProcess/host.test.ts`：真实RpcPeer/Runtime/model reverse端口、JSON保真、私有边界、在途取消及预取消不启动。

## 验证

新增端口测试先失败于缺失 completeKnowledge；LlmClient契约测试先失败于缺少第四参数；动态并发测试先失败于旧limiter实例绕开active预算，然后实施修复。

最终定向命令（模型均为确定性桩，无源码外发）：

```powershell
cd electron-agent
$env:TEMP='C:\Users\rxstudio\AppData\Local\Temp'
$env:TMP=$env:TEMP
node node_modules/vitest/vitest.mjs run electron/agentData/knowledgeCompletion.test.ts electron/agentDataProcess/host.test.ts electron/agentData/wikiEngine electron/app/agentDataService.test.ts electron/agentData/agentDataSettings.test.ts electron/pi/systemWorkerManager.test.ts electron/agent/shortCall.test.ts
```

**19文件、101/101通过，exit 0，8.28s。** 日志：[scheduler-tests-normal.log](./scheduler-tests-normal.log)。覆盖旧知识库全部本次相关引擎测试；没有运行UI或全仓测试。

默认沙箱先使既有localhost TCP测试报EACCES；另一个新动态预算测试最初在第四请求尚未越过异步facade启动时就释放旧调用，纠正测试的调度前置条件后重跑。最终正常权限下上述完整定向套件全过，没有跳过失败项。

严格叶子类型检查通过：

```text
tsc --ignoreConfig --noEmit --strict --skipLibCheck --moduleResolution Bundler --module ESNext --target ES2022 --types node electron/agentDataProcess/modelPort.ts electron/agentData/wikiEngine/llm.ts electron/agentData/wikiEngine/ingest/concurrency.ts
```

完整 `tsc -p tsconfig.node.json --noEmit` **没有通过**，153条诊断，详见 [scheduler-types.log](./scheduler-types.log)。新增方法、新文件和新测试未出现诊断；所触及旧文件仍有 `WikiService` 原有 logger.error签名（当前1423行）和 `AgentDataService` 原有 createThread/createTurn到Record参数的两个索引签名错误（当前240/243行），没有扩大本次范围处理。另有既有ThreadStore sqlite、CodeGraphQuery、其他模块测试等错误，不能宣称完整类型门禁全绿。

`git diff --check` 对本次修改生产文件通过（仅CRLF/LF提示）。根目录 `npm run verify-notes` 正常权限下通过：132篇笔记、归档/证据门禁有效，6条原有证据警告；日志：[scheduler-notes-normal.log](./scheduler-notes-normal.log)。默认沙箱的pnpm路径canonicalize失败不作为最终结论。

## 交接边界

本报告证明共享生产Wiki限流器和私有服务接缝；宿主main配置选择/缓存绑定、RepoWikiService接线、真实RepoWiki OS child + 真实agentdata-host + 真实ModelRuntimeHost底层SDK桩的整链验证由根代理及专门集成代理负责。没有把RpcPeer fakeProcess测试冒称真实OS child证据。当前此接缝无剩余执行阻塞。

## Review 补充：同模型配置身份

同 provider/id 修改 endpoint 等配置时，原 expectedModel 不足以辨别缓存身份。按 review 的收敛方案，新增可选 `expectedConfiguration?: string`（opaque SHA-256）。

- `KnowledgeCompletionInput`、`CompleteOptions`、纯 `AgentDataModelPort.complete` 类型均包含该字段。
- 私有 process RPC 要求它是64位十六进制字符串，非法值在进入模型调度前拒绝。
- WikiService 从排队输入显式传给 CompleteFn；facade、runtime、assemble 和 model reverse IPC 的既有透传继续保留该字段，未削弱原 expectedModel 两层检查。
- 兼容不带配置身份的既有知识请求。最终捕获真实model快照、同步比较identity以及缓存key绑定由根代理的宿主模型工厂处理，此接缝不自行重算或猜测身份。

先看到3项预期失败：inproc completion 丢身份、child completion 丢身份、非法hash仍发模型，日志 [scheduler-configuration-red.log](./scheduler-configuration-red.log)。修复后定向重跑 `knowledgeCompletion.test.ts`、`agentDataProcess/host.test.ts`、`wikiEngine/llm.test.ts`、`ingest/concurrency.test.ts`：**4文件、27/27通过**，exit 0，3.52s，日志 [scheduler-configuration-tests.log](./scheduler-configuration-tests.log)。严格叶子类型检查再次通过。没有重复全101项或增加账本。
