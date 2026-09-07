# Electron 内置 CodeGraph SDK 实现计划

> **面向 AI 代理的工作者：** 使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务实现，遵守 TDD。用户已确认设计边界；保留当前工作树，不提交无关改动。

**目标：** 用内置 CodeGraph 1.6.0 SDK 替换 Electron 的外部 CLI/MCP，统一结构化查询与任务生命周期。

**架构：** CodeGraphService 保留 AgentData 接口，CodeGraphEngine 管理 SDK 实例和任务，codeGraphQuery 只处理七种结构化查询。GUI 和 Agent 共享结果，但分别消费结构化数据与可读文本。

**技术栈：** TypeScript、Electron 38、CodeGraph 1.6.0、node:sqlite、Rust N-API/WASM、Vitest、pnpm。

## 1. 固定依赖及分发

文件：`electron-agent/package.json`、`pnpm-lock.yaml`、`electron.vite.config.ts`、`electron-builder.yml`。

- [x] 在 package.json 以精确版本加入 `"@colbymchenry/codegraph": "1.6.0"`，用 `pnpm install --ignore-scripts` 更新现有锁文件。
- [x] 保持主包及平台包 external，在 asarUnpack 中包括 `node_modules/@colbymchenry/**`，保留内部 worker、grammar 和 SQL 路径。
- [x] 配置测试断言依赖精确版本、external/asarUnpack 覆盖平台包，先见失败再修改配置。
- [x] 真实 Electron 探针核对应用内 Node、SQLite、原生 kernel 及 SDK 根入口，不使用全局 CLI。

## 2. 结构化查询

文件：新增 `electron-agent/electron/app/codeGraph/codeGraphQuery.ts` 与 `.test.ts`；扩展 `electron/agentData/codeRetrievalProtocol.ts` 的结果类型。

- [x] 测试先创建临时两文件仓库，调用真实 SDK 建图，再调用查询适配器。关键断言：

```ts
const result = await executeCodeGraphTool(graph, workspace, 'codegraph_search', { query: 'parse' });
expect(result.structuredContent.rows).toEqual(expect.arrayContaining([
  expect.objectContaining({ symbol: 'parse', file: 'src/parser.ts', line: 1 }),
]));
```

- [x] 运行 `node node_modules/vitest/vitest.mjs run electron/app/codeGraph/codeGraphQuery.test.ts`，先确认缺少查询实现导致失败。
- [x] 实现搜索、文件、符号/文件详情、调用者、被调用者、影响和上下文查询；使用 `{schemaVersion:1,rows,nodes,edges}`，Map 转数组，不导入 ToolHandler。
- [x] 补充同名消歧、Windows 路径、越界/符号链接源码读取、空结果与错误测试；同一命令通过。

## 3. 实例引擎与任务

文件：新增 `electron-agent/electron/app/codeGraph/codeGraphEngine.ts` 与 `.test.ts`；替换 `codeGraphService.ts`、`indexProbe.ts`；移除失去调用者的 CLI runner/MCP pool 及对应旧测试。

- [x] 覆盖缺失索引查询拒绝并且没有创建 `.codegraph`；完整 SDK 任务后统计及 structuredContent 不丢失；同一工作区重复索引拒绝。
- [x] 覆盖取消/退出：取消请求不能在 SDK promise 结束前关闭 graph；close 等待在途操作，关闭后拒绝新请求。
- [x] 实现按工作区的实例、共享打开 Promise、在途读取追踪、AbortController 及关闭顺序；用 SDK `isInitialized`/数据库文件探测替代目录判断。
- [x] 调用 `indexAll({signal,onProgress})`；sync 同样传 signal，但在完成后检查取消标记，明确不承诺其内部立即中止；`success:false` 不能计为成功。
- [x] 运行 `node node_modules/vitest/vitest.mjs run electron/app/codeGraph`，断言所有生命周期测试通过。

## 4. 消费者接入与回归

文件：`electron/main.ts`、`electron/app/agentDataService.ts`、`electron/agentData/runtime.ts`、`electron/app/agentDataDiagnostics.ts`、`src/lib/agentData.ts`、`src/features/agentData/codeResult.ts`、`extensions/code-retrieval/tools.ts` 及相应测试。

- [x] 先写 GUI 解析结构化结果、未知文本不伪造路径、Agent 直接透传可读 content 的测试。
- [x] 接入真实异步状态与阶段；使用现有任务取消协议，退出等待 SDK 关闭；旧 RPC 名称保持不变。
- [x] 运行 codeGraph、AgentData runtime/diagnostics、源码/关系面板和 code-retrieval 扩展测试；每次只修本次迁移造成的回归。
- [x] 运行 Electron 构建与独立类型检查，明确区分既有类型错误与新错误。
- [ ] 运行真实临时项目 SDK 集成测试、打包资源检查；不访问用户数据库或已有索引。
- [x] 更新 `docs/architecture.md` 与 `docs/agent-data-memory-code.md` 中 CodeGraph 接入说明，最后执行 `git diff --check` 并按规格自审。

## 当前验证基线

`node node_modules/vitest/vitest.mjs run electron/app/codeGraph electron/agentData/codeRetrievalProtocol.test.ts src/features/agentData/codeResult.test.ts src/lib/agentDataCodeBridge.test.ts`：7 个文件、96 项测试通过。并行子代理接口此前多次返回 websocket_disabled；若仍不可用，主代理内联执行并分别进行规格/质量复查。

## 交付验证（2026-09-06）

- 新增 SDK 查询、实例引擎、任务适配器和版本化结果，移除旧 CLI runner/MCP pool。保留 AgentData 的工具名、项目隔离、源码入口与用户已有索引。
- `pnpm test:codegraph`：7 个文件、38 项测试通过，使用 Electron 38.8.6 / Node 22.22.0。覆盖真实 SDK 索引、增量同步、调用关系、RPC、目录链接越界、并发、取消、退出和分发钩子。
- 扩大回归：20 个文件、204 项测试通过，包含相关 AgentData runtime、诊断、Renderer 源码/关系面板与 IPC。扩展 `code-retrieval` 的另外 13 项测试通过。
- `pnpm build` 通过；针对变更的 `git diff --check` 通过。独立 `tsc --noEmit -p tsconfig.node.json --incremental false --composite false` 仍报告 threadStore、权限、旧腾讯 runtime 测试等项目内错误；本次新增 CodeGraph 文件没有类型错误。不能把构建结果解读成全库类型检查通过。
- 初次 Windows 未签名目录包已构建。实际 SDK 冒烟发现 builder 排除了平台包的 `lib/node_modules`，因此加入 `package-codegraph.cjs` / `afterPack`，并从物理解包路径加载 SDK。执行同一钩子补齐初次目录包后，在该包的 Electron 中成功索引并查询临时 TS 文件。
- 自动集成该钩子的最终完整目录包复验在依赖处理阶段耗时较长，已停止临时构建进程；未宣称最终完整安装包已验收。没有发布、签名或修改用户安装。
- SDK 同步不承诺立即中止；取消等待 SDK 结束后记录终态。未知或不一致的进度统计只显示阶段，不传给任务计数校验。旧的 indexing 标记显示为部分索引，不冒充活动任务。
- 子代理接口持续不可用，规格与质量复查由主代理完成。未提交任何代码，未重启用户应用，未修改用户已有数据库或索引。大型仓库及常规 GUI 启动下的 WASM 压力测试尚未进行。
