# TencentDB 原生后台面板设计

日期：2026-08-18

## 目标

为 Pi 增加一个按钮，直接打开 TencentDB-Agent-Memory 原生 `MemoryPanel`。
面板由应用托管，不要求用户单独启动服务；Local 和 Remote 两种连接模式都可用。

## 已确认决策

- 原生面板：上游 `MemoryPanel`，包含 Team、User、Agent、Task、Chat Memory、Skill、Wiki、Code Graph 等控制台页面。
- 托管方式：Panel 后端和 Web 静态资源随 TencentDB runtime 打包。
- 连接模式：应用始终托管本机 Panel；Panel 根据当前连接配置代理本机或远程 Core/Knowledge。
- 打开方式：使用系统默认浏览器，不嵌入 Tauri 窗口或应用标签页。
- 登录方式：一次性短期 bootstrap token 自动建立原生面板会话。
- 凭据约束：User Key 不出现在 URL、浏览器历史或普通日志中；面板会话仍遵循上游的本地会话存储机制。
- 按钮位置：TencentDB「连接设置」操作区。

## 范围

### 包装运行时

构建脚本从固定的 TencentDB-Agent-Memory 源码归档构建 `MemoryPanel` 后端和 Web 前端，输出到现有 TencentDB runtime 目录。构建必须继续使用固定源码和 Node 归档摘要校验，并在 manifest 中记录 Panel 构建标记。

Panel 运行时只保留生产所需内容：后端编译产物、生产依赖、Web `dist` 和静态资源。开发依赖、测试文件、源码仓库元数据不进入发布包。

Panel 入口增加两项托管适配：

1. 从环境变量读取单实例注册信息，避免把 Gateway API Key 写入持久化配置文件。
2. 响应 stdin EOF，随父进程关闭；同时保留 SIGINT/SIGTERM 处理。

### 进程生命周期

新增独立 `PanelRuntime`，与现有 Core/Knowledge runtime 使用同一套进程守护和退出清理策略：

- 监听地址固定为 `127.0.0.1`。
- 端口由应用动态分配，避免固定端口冲突。
- 应用启动时启动 Panel；Local 模式先启动 Core/Knowledge，再启动 Panel；Remote 模式只启动 Panel。
- 应用退出时先停止 Panel，再停止 Core/Knowledge。
- Panel 异常退出时状态变为 failed；下一次打开按钮可执行一次清理并重启。
- 连接配置、Gateway API Key、User Key 或 Knowledge 端点变化时重启 Panel，使其使用新配置。

Panel 启动环境由当前连接配置生成：

- `METADATA_INSTANCES_CONFIG`：单实例注册信息，包含 service ID、Gateway endpoint、Gateway API Key。
- `KNOWLEDGE_SERVICE_URL`：当前 Knowledge endpoint。
- `HOST` / `PORT` / `UI_DIST_DIR`：本机监听和静态资源路径。
- LLM 配置沿用现有 TencentDB 本机配置；Panel 的启动绑定同步关闭，避免打开面板产生隐式写操作。

Panel 进程只接收必要凭据；凭据不写入普通应用日志，不传给 Pi 工具子进程。

### 自动登录协议

按钮调用新的 Tauri command：

1. 确认当前 TencentDB 配置和 Panel runtime 已就绪。
2. 生成随机、单次、60 秒有效的 bootstrap token。
3. 通过仅限回环地址的 Panel 内部注册接口提交 token 与当前实例身份。
4. 用 `tauri-plugin-opener` 打开 `http://127.0.0.1:<panel-port>/#tdai-bootstrap=<token>`。

Panel 后端仅接受带内部共享密钥的回环注册请求；注册 token 只能消费一次，成功或过期后立即删除。浏览器只看到 token，不看到 Gateway API Key 或 User Key。前端启动时消费 fragment，完成原生 `LoginGate` 所需会话初始化，随后用 `history.replaceState` 清除 fragment。

普通手动登录流程保留，bootstrap 失败时回退到原生登录页。

### UI

在 `ConnectionSettings` 操作区增加「打开原生后台」按钮：

- Panel 未就绪时显示 loading，避免重复点击。
- 成功后调用系统默认浏览器。
- 启动、注册或打开失败时显示可读错误，不打开空白页。
- Remote 模式沿用当前 Service ID、Team ID、Agent ID、User ID 和 User Key；Local 模式使用应用生成的固定单用户身份。

## 数据流

```text
ConnectionSettings
    -> tencentdb_open_panel
    -> PanelRuntime.ensure_started
    -> POST 127.0.0.1 /bootstrap/register
    -> openUrl(http://127.0.0.1:<port>/#tdai-bootstrap=<token>)
    -> Panel Web consume token
    -> native MemoryPanel session
    -> Panel API proxy
    -> selected local/remote Core + Knowledge
```

Panel 后端始终是浏览器唯一 API 入口。浏览器不直接携带 Gateway API Key，也不直接访问 Core 的管理接口。

## 错误与安全

- 未配置 Gateway/User Key：command 返回配置错误，按钮显示先完成连接配置。
- Remote 缺少合法 Core 或 Knowledge URL：禁止启动 Panel。
- Panel 端口被占用：重新分配回环端口；连续失败才报告错误。
- Panel 启动超时或健康检查失败：回收子进程，保留 failed 状态。
- bootstrap token 缺失、过期、重复消费或签名不匹配：返回 401，前端回退原生登录页。
- Panel 只绑定回环地址；内部注册接口要求共享密钥，不能从局域网调用。
- URL 只包含随机 token；User Key 不写入 URL、query、fragment、日志或生成的静态资源。
- 关闭应用必须回收 Panel 及其子进程，Windows 使用现有 Job Object / ProcessGuard。

## 测试与验收

### 构建

- runtime 构建成功并包含 Panel 后端生产产物、Web `dist` 和 manifest 标记。
- `--verify` 检查 Panel 入口、静态首页、stdin shutdown、bootstrap 路由和摘要锁定。

### Rust

- PanelRuntime Local/Remote 启动、健康检查、端口分配、重启和退出清理。
- Panel 进程异常退出后状态和下一次恢复行为。
- bootstrap token 单次消费、过期、错误 token、远程模式身份绑定。
- `tencentdb_open_panel` 返回合法回环 URL，且 URL 不含任何凭据字段。

### Web

- 按钮在 stopped/starting/ready/failed 状态下的显示和禁用行为。
- command 成功调用 `openUrl`；失败显示错误。
- bootstrap 成功建立会话并清除 URL fragment；失败回退 LoginGate。

### 集成

- Local：应用启动三项托管服务，浏览器可打开原生面板并完成自动登录。
- Remote：本机只启动 Panel，面板页面可访问远程 Core/Knowledge 资产。
- 应用退出后 Panel 端口释放，Core/Knowledge 原有功能不回归。

## 非目标

- 不重写 MemoryPanel 页面或业务 API。
- 不把 Panel 嵌入 Tauri WebView。
- 不新增团队权限模型；沿用上游 Panel 和 TencentDB Core 的权限校验。
- 不迁移或恢复旧知识库、长期记忆、代码索引数据。
