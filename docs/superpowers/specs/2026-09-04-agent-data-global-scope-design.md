# Agent 数据中心：全局作用域重构设计

日期：2026-09-04
状态：设计已确认，待编写实现计划

## 1. 背景与问题

"Agent 数据"模块在导航层（`moduleStore.ts` 的注释、`ModuleRail.tsx`）被定性为"全局模块"，和"设置""用量"同级、常驻最左侧图标栏，暗示它管理的是应用级、跨项目的数据。但当前实现与这个定位不符：

- `AgentDataCenter` 从 `ModuleContainer` 接收 `workspace={activeWorkspace}`（来自 `useSessionStore`，本质是当前对话/项目绑定的 cwd），并把它作为 Memory/Wiki/Code 三个子面板的强制过滤条件。
- 用户在侧边栏切换对话或项目，`activeWorkspace` 跟着变化，`AgentDataCenter` 的 `useEffect(() => { void refresh(); }, [userId, workspace])` 立即重新拉取数据——面板内容会跟着切换甚至清空，即使用户当时正停留在"Agent 数据"模块查看别的东西。
- Memory/Wiki 两个子面板在缺少 `workspace` 时直接显示"未绑定工作区"空态，不提供任何"查看全部"的入口。
- 主进程 `MemoryStore` 底层已经实现了 `memory_scope='global'` 和 `includeOtherProjects` 跨项目查询能力（`electron/agentData/memoryStore.ts`），但渲染层的 `MemoryScope` 类型（`src/lib/agentData.ts`）和 IPC 转发（`electron/ipc/register.ts` 的 `agentData_memory_overview`/`agentData_memory_search`）都没有把这两个字段透出去——是一个"写了一半但没接出来"的半成品。
- Wiki 存储（`electron/agentData/wikiStore.ts`）用 `PRIMARY KEY(workspace, page)` 硬隔离，没有任何全局查询选项。
- CodeGraph 完全没有主进程存储层，`codeRetrieval.admin.status` 是硬编码占位符（恒返回 `{connected:false}`），实际查询走 `extensions/code-retrieval/mcpClient.ts` 每次现开一个 `codegraph serve --mcp` 子进程、用完即关。
- `agent_jobs` 表里的 `wiki.sync`/`codegraph.sync` job 创建后没有任何执行器消费——会一直停在 `pending`，直到用户手动取消。CodeGraph 索引目前只能靠用户在终端手动跑 `codegraph init` 建立。

这次重构的目标：让"全局模块"的定位和实际数据模型一致，同时把 `wiki.sync`/`codegraph.sync` 两个 job 补上真正的执行器。

## 2. 设计原则

三类数据（Memory / Wiki / CodeGraph）的存储层都保留"来源项目"字段用于溯源和可选筛选，但查询侧默认行为从"按当前项目强制过滤"改为"默认全局，项目筛选可选"。变化的是默认行为，不是删除项目维度这个概念。

三类数据的读取形态本质不同，不合并成统一的"资产列表"：
- **Memory**：可以跨项目合并查看（L1 事实带来源标记，L2/L3 认知天然全局）。
- **Wiki**：可以跨项目合并查看（文档知识没有互斥性）。
- **CodeGraph**：**不能**跨项目合并——不同代码库的符号空间彼此独立，合并没有意义，必须显式选择一个项目再查询。

不引入 Team / 多用户 / ACL；不做 LLM 驱动的场景合并去重或数量上限强制合并；不做跨项目二次提炼的独立摘要任务；不把三类数据合并成统一的资产浏览列表。这些是本次明确排除的范围，参考了 TencentDB-Agent-Memory 的设计但不照搬其面向多租户服务端的复杂机制。

## 3. Memory

### 3.1 写入路径（基本不变）

L1 继续逐 session 触发写入，保留来源 `project_id` 标记（`extensions/memory/capture.ts` → `memory.upsert`/`memory.capture` RPC → `MemoryStore`，写入逻辑不变）。

新写入的 L2/L3 默认标记为 `global` scope，不再落到发起 session 所在的 project：`electron/app/memoryService.ts` 的 `MemoryService.completeExtraction()` 目前把 L1/L2/L3 都用同一个 `capture.scope`（继承自请求时的 `project` scope）写入；改为 L1 沿用原 scope，L2/L3 显式传 `{ ...capture.scope, scope: 'global' }`。这样每次 session 结束产出的情景摘要（L2）和长期认知（L3）都汇入全局池子，任何项目下次都能查到，不需要新的调度器或任务类型。

### 3.2 读取路径（改默认值）

`MemoryStore.search()`/`overview()` 的 SQL 已支持 `memory_scope='global' OR project_id=? OR (includeOtherProjects=1 AND project_id IS NOT NULL)`，不需要改 schema 或 SQL。改动集中在把这两个字段从"未暴露"变成"默认全局"：

- 渲染层 `MemoryScope` 类型（`src/lib/agentData.ts`）补全 `projectId`/`scope`/`includeOtherProjects` 字段。
- `electron/ipc/register.ts` 里 `agentData_memory_overview`/`agentData_memory_search`/`agentData_memory_delete` 的参数转发补上这几个字段。
- `MemoryPanel.tsx` 默认调用时传 `includeOtherProjects: true`（即默认展示全局），不再要求 `workspace` 存在才显示内容——`workspace` 变成可选的筛选参数而不是必需的过滤条件。

### 3.3 面板交互

Memory tab 去掉"未绑定工作区"的空状态门槛，默认直接显示全局概览/搜索结果。面板内新增一个项目筛选器（下拉），选项来自侧边栏已注册的项目列表（`useSessionStore` 的 `registeredProjects` + 当前活跃项目去重后的集合，复用 `useProjectGroups` 已有的聚合逻辑，不新造数据源）：

- 不选（默认状态="全局"）：显示所有全局 L2/L3 + 所有项目的 L1。
- 选中具体项目：显示该项目的 L1 事实 + 所有全局 L2/L3（因为 L2/L3 本来就不属于任何单一项目）。

删除操作（`memory.delete`）保持按具体记录 id 删除，不受筛选器状态影响。

## 4. Wiki

### 4.1 写入路径（不变）

`wiki.sync` job 仍是"对当前项目跑一次"的语义，扫描该项目工作区下的 Markdown 生成/更新页面，`wikiStore.replacePage()` 继续用 `PRIMARY KEY(workspace, page)` 存储——不改 schema，避免不同项目的同名页面互相覆盖。

### 4.2 读取路径（改默认值）

`WikiStore.search()`/`overview()` 新增无 workspace 过滤的查询方法（或让现有方法的 `workspace` 参数变为可选，为空时不加 `WHERE workspace=?` 条件，全表 FTS 匹配）。渲染层 `WikiPanel.tsx` 默认不传 `workspace`，展示全局搜索结果；同样提供项目筛选器缩小范围，用法和 Memory 一致。

### 4.3 Wiki 同步执行器（新增，修复现有 bug）

现状：`WikiPanel` 点"同步 Wiki"只是插入一条 `pending` 状态的 `agent_jobs` 记录，没有任何代码消费它。

修复方案需要注意一个关键约束：`SystemWorkerManager` 拉起的无界面 pi 子进程带有环境变量 `PI_SYSTEM_WORKER=1`，`cli/src/runtime.ts` 里这个变量会让子进程**加载零扩展**（`extensionFactories: []`）。也就是说系统 worker 进程里没有任何工具可调，包括 `wiki-rag` 扩展本身——现有 `memory_extract` 能工作，靠的是直接给系统 worker 发一段纯文本 prompt，模型把结果当文本吐出来，主进程自己解析文本并写入存储（`memoryService.ts` 的 `completeExtraction()`），全程不经过任何扩展。Wiki 同步必须照抄这个真实机制，不能指望"新增一个扩展工具给系统 worker 调用"：

1. `SystemWorkerManager`（`electron/pi/systemWorkerManager.ts`）新增一个任务 kind `wiki_page_generate`：`serviceTaskPrompt()` 为这个 kind 生成"把源文本写成简洁 Markdown 知识页面"的提示词（复用 `extensions/wiki-rag/sync.ts` 里现有的 `SYSTEM` 提示词文案），`parseWorkerOutput()` 对这个 kind 直接返回原始文本（不当 JSON 解析）。这是给现有两个函数加一个 kind 分支，不改变已有的 `memory_extract` 行为。
2. 主进程新增一个编排器（`electron/app/wikiSyncService.ts`），负责整个同步流程：枚举工作区 Markdown 文件（在主进程内实现等价的扫描逻辑，不 import `extensions/wiki-rag`——两个包本来就不能互相引用，这和 `MemoryScope` 类型在 `extensions/memory/store.ts` 与 `electron/agentData/memoryStore.ts` 两处各自定义一份是同一种既有模式）→ 对每个文件调用 `systemWorker.run({kind:'wiki_page_generate', input:{source}})` 拿到生成的 Markdown → 直接调 `wiki.replace` RPC 写入 → 更新 job 进度。
3. 任务全部完成后把对应 `agent_jobs` 行状态更新为 `completed`（按"已处理文件数/总文件数"实时更新进度，文件列表在开始前已知）；任一环节失败则整体标记为 `failed` + 错误摘要（不做部分失败的复杂状态）。

不新增任务类型体系，不新增调度器；复用 `TaskQueue`/`SystemWorkerManager` 现成的重试、超时、并发控制，以及 `memory_extract` 已验证过的"系统 worker 只认文本 prompt"的通信方式。

## 5. CodeGraph

### 5.1 索引发现（运行时探测，不新增持久化注册表）

不新增数据库表记录"哪些工作区建过索引"。因为 job 完成时机在当前实现里并不可靠（见 5.2 的修复前提是本次一起做），更稳妥的方式是运行时按需探测：打开 Code tab 时，主进程对已注册的项目列表逐一检查 `<项目路径>/.codegraph` 目录是否存在（纯文件系统 `existsSync`，无需打开索引），实时得出"哪些项目已建索引"。这个检查已经是 `mcpClient.ts::connectCodeGraph()` 现有逻辑的一部分，只是把它提升为一个可批量查询的 IPC 方法。

### 5.2 CodeGraph 同步执行器（新增，修复现有 bug）

现状：`codegraph.sync` job 创建后同样没有执行器消费；索引的建立目前只能靠用户手动在终端跑 `codegraph init`。

修复方案：CodeGraph 同步不需要 LLM，是纯子进程调用，可以直接在主进程执行（参考历史 Tauri 版本 `code_intel.rs` 已验证的命令形状）：

1. Job 创建后，主进程立即判断：`.codegraph` 不存在 → 跑 `codegraph init`；已存在 → 跑 `codegraph sync`（增量）。命令参数遵循现有 `GREN_CODEGRAPH_COMMAND` 覆盖机制，保持和 `mcpClient.ts` 一致的可配置性。
2. 子进程退出码为 0 → job 标记 `completed`；非 0 → job 标记 `failed`，`error` 字段写入 stderr 摘要（截断到合理长度，不整段落盘）。
3. 同步成功后，通知实例池丢弃该 workspace 现有的常驻连接（如果有），下次查询时惰性重新拉起，保证读到的是同步后的最新索引。
4. 同一 workspace 已有 `pending`/`running` 状态的 `codegraph.sync` job 时，不允许再创建新的（避免两个 `codegraph sync` 子进程并发写同一个 `.codegraph/codegraph.db` 造成损坏）——这是同步功能本身正确性的必要前提，不是额外范围。

### 5.3 实例池（新增）

主进程维护一个按 workspace 键控的 CodeGraph 子进程池（`Map<workspace, CodeGraphClient>`），查询时惰性拉起、常驻复用，不再是现在"每次查询现开现关"的模式：

- 首次查询某 workspace：池中没有则调用 `connectCodeGraph()` 拉起子进程，存入池子。
- 后续查询同一 workspace：直接复用池中的连接。
- 空闲超时自动关闭：默认 15 分钟无查询自动关闭子进程释放资源，下次查询再重新拉起（具体阈值后续可调，不需要做成用户可配置项）。
- 同步完成（5.2 第 3 步）或应用退出时主动关闭对应连接。

### 5.4 面板交互

Code tab 的项目选择器是**强制的**（区别于 Memory/Wiki 的可选筛选器）：不选中任何项目时显示空态提示"请选择一个项目"，不展示任何聚合数据。

选择器列出**全部已注册项目**（不限于已建索引的），每项标注索引状态（5.1 的运行时探测结果）：

- 选中一个已索引的项目 → 显示查询 UI（搜索框、结果表格）。
- 选中一个尚未索引的项目 → 显示"该项目尚未建立 CodeGraph 索引"空态，提供"同步索引"按钮，点击后对**当前选中的项目**（不是 `activeWorkspace`）触发 5.2 的 job 创建流程。

面板打开时的初始选中项：如果 `activeWorkspace` 在已注册项目列表中，默认预选它（无论是否已索引）；否则不预选。这只影响初始值，用户手动切换选择器后，选择状态是面板本地 state，不再跟随 `activeWorkspace` 变化（呼应第 7 节的解耦原则）。

## 6. 取消操作必须真正终止后台工作

现状缺陷：`JobStore.cancel()` 只把数据库行状态改成 `cancelled`，不终止任何实际在跑的后台工作——用户点"取消"后状态显示已取消，但同步可能仍在后台运行，结果具有误导性。5.2/4.3 新增了真正的执行器后，这个问题必须一并修，否则新执行器会让这个既有缺陷首次变得可观察（之前反正也没人在跑，取消不取消没区别；现在真的会有进程/任务在跑）。

- **Wiki 同步取消**：`WikiSyncService`（4.3 新增的编排器）逐文件调用 `systemWorker.run()`，不经过 `TaskQueue`，`SystemWorkerManager` 本身不支持中途中断单个已发出的任务。取消因此是"协作式"的：编排器为每个 job 维护一个中止标记，取消时置位该标记；文件循环等当前正在处理的文件完成生成调用（或触发该任务已有的超时）后检查标记，命中则不再处理剩余文件，并把 job 状态落定为 `cancelled`。这不是"立即打断"，但避免了对 `SystemWorkerManager` 做侵入式改造，且不违反下文"真正终止后才落定状态"的约束。
- **CodeGraph 同步取消**：主进程持有同步子进程的引用（5.2 第 1 步启动时保存），取消时直接 kill 该子进程，`.codegraph` 目录可能处于不完整状态，下次同步会重新覆盖，不需要额外回滚逻辑。
- 两种取消都需要在子进程/任务真正终止后才把 job 状态落定为 `cancelled`，避免"状态已取消但进程仍在写文件"的竞态。

## 7. 面板信息架构

保持现有六个 tab（概览 / 任务 / Memory / Wiki / Code Retrieval / 审计诊断），不合并成统一资产列表——三类数据交互形态差异太大，合并只是表面统一，会让每个 tab 的操作变复杂。

具体调整：

- **概览 tab**：Memory/Wiki 的 KPI 卡片改为默认统计全局数据，不再需要 `userId && workspace` 同时存在才显示（`AgentDataCenter.tsx` 的 `refresh()` 里 `if (userId && workspace)` 分支改为始终请求，`workspace` 从必需参数变为可选筛选参数）。Code 卡片继续要求显式选择项目才能显示统计，否则显示"请选择项目"提示。
- **Memory / Wiki tab**：去掉"未绑定工作区"空状态门槛，默认展示全局数据，各自带一个可选项目筛选器（3.3 / 4.2 已述）。
- **Code tab**：项目选择器强制存在，不选则空态提示（5.4）。
- **任务 / 审计诊断 tab**：不变，本来就是全局展示。

`AgentDataCenter` 不再从 `ModuleContainer` 接收 `activeWorkspace` 作为强制过滤条件传给子面板。它可以选择性地拿 `activeWorkspace` 作为项目筛选器的初始默认值（例如 Code tab 打开时默认预选当前项目，方便"打开就能看当前项目"），但这个筛选状态是面板自己的本地 state，用户在面板内手动切换后就不再跟随对话/项目切换——和侧边栏的 `activeWorkspace` 变化彻底解耦，直到用户在面板里重新选择。

## 8. 数据流示意

```text
Memory 读取：
  MemoryPanel（默认 includeOtherProjects=true，可选 projectId 筛选）
    → agentData_memory_overview / agentData_memory_search（IPC，补全 scope 字段转发）
    → memory.admin.overview / memory.search（RPC）
    → MemoryStore.overview/search（SQL 已支持，不改）

Memory 写入（L2/L3 落 global）：
  extensions/memory/capture.ts（session 结束触发）
    → memory.capture（RPC，带 project scope）
    → MemoryService.completeExtraction()
        L1 → store.upsert(capture.scope, ...)          // 不变，project scope
        L2/L3 → store.upsert({...capture.scope, scope:'global'}, ...)  // 改动点

Wiki 同步（新增执行器）：
  WikiPanel「同步」
    → agentData_jobs_create({kind:'wiki.sync', workspace})
    → JobStore.create（pending）
    → WikiSyncService（主进程新编排器）：
        扫描 workspace 下的 Markdown 文件
        逐个文件 → systemWorker.run({kind:'wiki_page_generate', input:{source}})
                 → SystemWorkerManager 拉起无界面 pi 子进程，发文本 prompt，取回文本结果
                 → wiki.replace（RPC 写入）
                 → JobStore 更新进度（已处理数/总数）
    → 全部完成后 JobStore 状态 → completed/failed

CodeGraph 同步（新增执行器）：
  CodeRetrievalPanel「同步索引」
    → agentData_jobs_create({kind:'codegraph.sync', workspace})
    → JobStore.create（pending，同 workspace 已有 pending/running 则拒绝）
    → 主进程直接跑子进程：.codegraph 不存在→ codegraph init；存在→ codegraph sync
    → 退出码 0/非0 → JobStore 状态 → completed/failed
    → 通知实例池丢弃该 workspace 旧连接

CodeGraph 查询（实例池）：
  CodeRetrievalPanel（强制选择项目）
    → agentData_code_search（IPC）
    → 实例池：命中则复用，未命中则 connectCodeGraph() 拉起子进程并缓存
    → 15 分钟空闲自动关闭
```

## 9. 明确不做的范围

- 不引入 Team / 多用户 / ACL（private/team/restricted）体系。
- 不做 TencentDB 那套 LLM 驱动的场景合并去重、场景数量上限强制合并（`scene_blocks` 式的持续合并单一文档）。
- 不做跨项目二次提炼的独立摘要任务（不新增"定期把多项目 L1 重新提炼成全局 L2/L3"这类调度任务）。
- 不把 Memory/Wiki/CodeGraph 合并成统一的资产浏览列表。
- 不做"codegraph CLI 自动安装"之类的环境配置能力，CLI 缺失时同步 job 按 5.2 第 2 步失败并给出清晰错误信息即可。
- 不做同步进度的精细百分比解析（CodeGraph CLI 的 stdout 格式未必稳定可解析，job 进度用 pending/running/completed/failed 状态区分，不伪造中间百分比）；Wiki 同步因为文件列表提前已知，可以按"已处理文件数/总数"给出真实进度。

## 10. 测试范围

- `MemoryStore`：`scope='global'` 写入路径的单测（L1 落 project、L2/L3 落 global 的边界情况）。
- IPC 层：`agentData_memory_overview`/`search` 转发 `includeOtherProjects`/`scope`/`projectId` 字段的单测。
- `WikiStore`：无 workspace 过滤的全局搜索单测。
- `SystemWorkerManager` 新增 `wiki_page_generate` kind 的 prompt 构造和文本结果解析单测（参考现有 `systemWorkerManager.test.ts` 里 `memory_extract` 分支的测试模式）。
- 新增的 `WikiSyncService` 编排器：文件枚举、逐页生成调用顺序、失败保留旧页面、进度更新的单测（参考现有 `capture.test.ts`/`sync.test.ts` 的 mock client 模式）。
- 新增的 CodeGraph 同步执行器：`.codegraph` 存在性判断分支（init vs sync）、子进程退出码映射 job 状态、并发拒绝（同 workspace 重复创建）的单测。
- 实例池：惰性加载、复用、空闲超时关闭、同步后失效重建的单测。
- 取消操作：Wiki 同步取消时对应系统任务被终止、CodeGraph 同步取消时子进程被 kill 的单测；job 状态只在进程/任务真正终止后才落定为 `cancelled` 的时序测试。
- 面板组件：Memory/Wiki 默认全局展示且不再要求 workspace 的渲染测试；Code tab 未选项目时的空态测试；Code tab 选中未索引项目时显示同步入口的测试；项目筛选器切换后不跟随 `activeWorkspace` 变化的测试。
