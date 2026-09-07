# Electron 内置 CodeGraph SDK

## 已确认边界

2026-09-06 用户确认：只修改 Electron 主线；参照 TencentDB-Agent-Memory 的库调用方式内置 CodeGraph SDK，保留 Rust/WASM，不再由 Pi 启动 CodeGraph CLI/MCP 子进程。现有项目、AgentData RPC、七个 Agent 查询工具、任务面板与源码入口继续使用。

## 运行时

固定 `@colbymchenry/codegraph` 为 `1.6.0`。主进程通过应用依赖加载 SDK，不查全局 PATH、不自安装、不自动升级。SDK 和平台包保持 external，原生模块、WASM、SQL 与 SDK 自带 worker 文件保留包内相对位置并在打包时解出 asar。

一个 CodeGraphEngine 管理工作区实例。相同工作区并发打开只产生一个实例，查询和索引共享该实例；索引进行中拒绝新查询，索引开始前等已有读取结束。同一工作区最多一个索引任务。SDK 的内部 worker 属于 SDK 实现，不引入新的 Pi 守护进程。

首次明确建立索引调用 `init({index:false})` 后 `indexAll`；已有索引调用 `sync`。不调用 `watch`、`recreate`、`uninitialize`，不删除或克隆用户工作区。仅 `.codegraph` 目录存在不代表索引存在，要检查数据库文件；打开失败保留原文件并显示错误。

## 查询合约

保留 `codeRetrieval.call` 及七种工具名。SDK 层提供可 JSON 序列化的结构化行、节点与边；节点保留稳定 ID、符号名、文件路径、行号、类型、签名。文件浏览使用 `getFiles`，搜索使用 `searchNodes`，符号及同名消歧使用节点 ID/名称/文件，关系使用 SDK 的节点和边，explore 使用 SDK context/subgraph 能力。

返回同时包含供 Agent 阅读的 `content` 和供 GUI 使用的版本化 `structuredContent`。Renderer 不从 Markdown 标题或关系文本猜测符号与文件；未知旧结果可展示原文但不生成伪造行。Agent 扩展直接使用 `content`，不把整个信封再 JSON 编码到文本里。

路径和七种只读操作继续在 AgentData 入口校验；读取源码还要校验真实路径留在工作区。低层 SDK 查询不保证与上游 ToolHandler 的所有排序、上下文裁剪策略逐字相同，不深度导入其私有 MCP 模块。

## 状态和生命周期

状态分清未初始化、加载失败、索引中、完整、过期和部分索引；`connected` 只表示实例已成功打开，统计来自 SDK，不把未知值伪装成零。诊断允许异步读取状态，继续不创建索引。

索引任务复用 `agent_jobs`，阶段与处理数量来自 SDK `onProgress`。不把阶段局部比例冒充全局完成百分比。

取消请求设置 AbortController，等待写入安全结束后才将任务置为 cancelled；不关闭仍在使用的 SQLite 连接。已验证 1.6.0 的 `indexAll` 接受 signal，但 `sync` 内部未转发 signal，因此后者不保证立即停止，取消可能保留已经完成的增量写入。应用退出先请求取消并等待在途操作，再关闭实例。

## 验证

采用 TDD 覆盖缺失索引不创建、真实结构化搜索/关系、路径隔离、并发打开、每工作区单任务、取消、退出、SDK 错误及状态统计。真实临时仓库验证完整索引、源码改动后的增量同步、重开、七种查询及状态。不得对用户现有索引运行写入测试。

已做的可行性探针：Electron 38.8.6 的 Node 22.22.0 在 RunAsNode 模式且使用 `--liftoff-only` 时，能加载 SQLite 与 Rust kernel，2 个 TS 文件生成 5 个节点和 6 条边，可查询 main 对 parse 的调用关系，重开及无变化同步通过。这不等于打包态与大型工作区性能已验证。

## 不在范围内

不修改 Tauri；不接入腾讯 HTTP 服务、多租户或远端克隆资产模型；不重写 Rust/Tree-sitter；不新增自动索引或升级服务；不提交其他既有工作树改动。
