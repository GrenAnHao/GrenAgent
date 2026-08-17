# TencentDB 原生后台面板实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `subagent-driven-development`（推荐）或 `executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 TencentDB-Agent-Memory 原生 `MemoryPanel` 随 Pi 打包托管，在 Local/Remote 模式下由按钮用系统浏览器打开，并通过一次性 bootstrap token 自动登录。

**架构：** 构建脚本固定下载并编译 `MemoryPanel` 后端和 Web 产物。Tauri 主进程新增独立 Panel 子进程管理器；Local 模式先启动 Core/Knowledge，Remote 模式只启动 Panel，Panel 始终绑定回环地址。按钮调用 Tauri command 注册一次性 token，返回不含凭据的 URL；浏览器消费 token 后写入上游原生面板会话。

**技术栈：** Rust/Tauri 2、Tokio、Reqwest、UUID、Node 22、TypeScript、Vite、React、Vitest、上游 Hono/React MemoryPanel。

---

## 文件边界

### Runtime 构建与上游适配

- 修改：`tauri-agent/scripts/build-tencentdb-memory.mjs` —— 下载、构建、裁剪、复制 Panel，并验证产物。
- 修改：`tauri-agent/scripts/tencentdb-runtime-patches.mjs` —— Panel stdin、环境注册表、bootstrap API/HTML 适配源码。
- 修改：`tauri-agent/scripts/tencentdb-runtime-patches.node-test.mjs` —— 适配函数的失败/通过测试。

### Rust 进程与命令

- 创建：`tauri-agent/src-tauri/src/tencentdb/panel.rs` —— Panel 连接配置、子进程生命周期、token 注册。
- 修改：`tauri-agent/src-tauri/src/tencentdb/mod.rs` —— 导出 Panel 模块及共享托管进程 helper。
- 修改：`tauri-agent/src-tauri/src/commands/tencentdb.rs` —— 启动编排和 `tencentdb_open_panel` command。
- 修改：`tauri-agent/src-tauri/src/lib.rs` —— 管理 PanelRuntime、应用启动/退出顺序、注册 command。

### 前端入口

- 修改：`tauri-agent/src/lib/tencentdb.ts` —— Panel 返回类型和 invoke API。
- 修改：`tauri-agent/src/features/tencentdb/ConnectionSettings.tsx` —— 原生后台按钮、loading、错误提示。
- 修改：`tauri-agent/src/features/tencentdb/ConnectionSettings.test.tsx` —— 成功/失败/重复点击测试。

### 文档

- 修改：`tauri-agent/README.md` —— 说明原生后台按钮、Local/Remote 代理和浏览器自动登录。

实现时只对上述文件及对应测试、生成 runtime 目录操作；不得暂存当前工作区已有的无关改动。

## 任务 1：构建并适配原生 MemoryPanel

**文件：**
- 修改：`tauri-agent/scripts/tencentdb-runtime-patches.mjs`
- 修改：`tauri-agent/scripts/tencentdb-runtime-patches.node-test.mjs`
- 修改：`tauri-agent/scripts/build-tencentdb-memory.mjs`

- [ ] **步骤 1：先写适配失败测试**

在 Node 测试文件中新增以下断言，覆盖所有新适配标记。fixture 直接沿用当前测试的内联字符串方式，不依赖未打包的上游源码路径：

```js
test('patches MemoryPanel for managed stdin shutdown and env registry', () => {
  const source = `process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);`;
  const patched = patchPanelStdinShutdown(source);
  assert.match(patched, /managed runtime stdin closed/);
  assert.match(patched, /process\.stdin\.once\("close"/);

  const registry = patchPanelInstanceRegistry(`static load(configPath) { return readFileSync(configPath, 'utf8'); }`);
  assert.match(registry, /TDAI_PANEL_INSTANCES_JSON/);
});

test('patches MemoryPanel bootstrap protocol without exposing credentials in URL', () => {
  const app = patchPanelBootstrapRoutes(`const app = new Hono(); return app;`);
  assert.match(app, /__grenagent\/bootstrap/);
  const html = panelBootstrapHtml();
  assert.match(html, /location\.hash/);
  assert.match(html, /tdai-panel\.session/);
  assert.doesNotMatch(html, /user[_-]?key|api[_-]?key/i);
});
```

断言只检查稳定协议标记，不绑定压缩后的 Web chunk 名称。

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
node --test scripts/tencentdb-runtime-patches.node-test.mjs
```

预期：新增测试因 `patchPanelStdinShutdown`、`patchPanelInstanceRegistry`、`patchPanelBootstrapRoutes` 或 `panelBootstrapHtml` 未导出而失败；现有 12 个适配测试保持通过。

- [ ] **步骤 3：实现 Panel 后端适配**

在 `tencentdb-runtime-patches.mjs` 增加并导出四个函数：

```js
export function patchPanelStdinShutdown(source) { /* 注入 stdin end/close -> process.exit(0) */ }
export function patchPanelInstanceRegistry(source) { /* 优先解析 TDAI_PANEL_INSTANCES_JSON */ }
export function panelBootstrapHtml() { /* 固定 HTML，读取 hash token、POST consume、写 localStorage、replace('/') */ }
export function patchPanelBootstrapRoutes(source) { /* 注册 register/consume/bootstrap 路由和内存 token store */ }
```

适配行为固定如下：

1. `TDAI_PANEL_INSTANCES_JSON` 通过现有 Zod schema 校验，成功后替代文件读取；环境变量缺失时保留上游文件读取行为。
2. `POST /__grenagent/bootstrap/register` 只接受回环 Panel 发出的共享密钥 Header、`token`、`instance_id`、`user_key`、`expires_at`；token TTL 上限 60 秒。
3. `POST /__grenagent/bootstrap/consume` 原子删除 token；过期/重复/错误 token 返回 401。成功后用上游 `metaKernel` 调用 `auth/verify`，返回 `{ session: { instanceId, instanceName, userKey, user } }`。
4. `GET /__grenagent/bootstrap` 返回固定 wrapper HTML。脚本从 `location.hash` 读取 token，调用 consume，将返回 session 写入 `localStorage['tdai-panel.session']`，再用 `location.replace('/')` 清除 fragment。
5. wrapper 不包含任何真实凭据；Panel request logger 不记录请求 body 或内部共享密钥。

所有插入点必须有 source marker 检查；上游布局变化时构建直接失败，不静默生成不完整 runtime。

- [ ] **步骤 4：扩展构建脚本**

在 `build-tencentdb-memory.mjs` 中：

1. 从固定 source archive 定位 `MemoryPanel`。
2. 对 Panel 后端执行 `npm install --legacy-peer-deps`、`npm run build`、`npm prune --omit=dev --legacy-peer-deps`。
3. 对 `MemoryPanel/web` 执行同样的 install/build/prune。
4. 应用三项 patch 后再编译，避免运行时源码和 dist 不一致。
5. 只复制 `panel/dist`、`panel/node_modules`、`panel/package.json`、`panel/web/dist`、`panel/web/public` 到 runtime；不复制测试、`.git`、开发依赖。
6. manifest 增加：

```json
"panel": {
  "backendEntry": "panel/dist/index.js",
  "webEntry": "panel/web/dist/index.html",
  "bootstrapProtocol": "v1"
}
```

7. `verifyLayout` 检查 Panel 后端入口、首页、`TDAI_PANEL_INSTANCES_JSON`、stdin shutdown、bootstrap 路由、`tdai-panel.session` 五类 marker。

- [ ] **步骤 5：运行适配和 runtime 验证**

运行：

```powershell
node --test scripts/tencentdb-runtime-patches.node-test.mjs
node --check scripts/build-tencentdb-memory.mjs
bun run build:tencentdb-memory
node scripts/build-tencentdb-memory.mjs --verify
```

预期：适配测试全部通过；runtime 构建完成；`--verify` 输出 `TencentDB runtime verified`，且 `panel/web/dist/index.html` 存在。

- [ ] **步骤 6：提交任务 1**

```powershell
git add tauri-agent/scripts/build-tencentdb-memory.mjs tauri-agent/scripts/tencentdb-runtime-patches.mjs tauri-agent/scripts/tencentdb-runtime-patches.node-test.mjs
git commit -m "feat: bundle native TencentDB panel runtime"
```

## 任务 2：实现 PanelRuntime 进程管理

**文件：**
- 创建：`tauri-agent/src-tauri/src/tencentdb/panel.rs`
- 修改：`tauri-agent/src-tauri/src/tencentdb/mod.rs`

- [ ] **步骤 1：先写纯函数和生命周期失败测试**

在 `panel.rs` 的 `#[cfg(test)]` 中先加入：

```rust
#[test]
fn panel_url_contains_only_loopback_and_fragment_token() {
    let url = panel_url("http://127.0.0.1:8123", "token-1").unwrap();
    assert_eq!(url, "http://127.0.0.1:8123/__grenagent/bootstrap#tdai-bootstrap=token-1");
    assert!(!url.contains("user_key"));
    assert!(!url.contains("api_key"));
}

#[test]
fn panel_connection_fingerprint_changes_on_endpoint_or_user_change() {
    let first = PanelConnection::test_value("https://core-a", "https://knowledge-a", "user-a");
    assert_eq!(first.fingerprint(), first.clone().fingerprint());
    assert_ne!(first.fingerprint(), PanelConnection::test_value("https://core-b", "https://knowledge-a", "user-a").fingerprint());
    assert_ne!(first.fingerprint(), PanelConnection::test_value("https://core-a", "https://knowledge-a", "user-b").fingerprint());
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml tencentdb::panel::tests
```

预期：因 `PanelConnection`、`panel_url`、`PanelRuntime` 尚未存在而失败。

- [ ] **步骤 3：实现 PanelRuntime 最小接口**

在 `panel.rs` 定义以下稳定接口：

```rust
#[derive(Clone, Debug)]
pub(crate) struct PanelConnection {
    pub mode: MemoryMode,
    pub service_id: String,
    pub user_id: String,
    pub gateway_endpoint: String,
    pub knowledge_endpoint: String,
    pub gateway_api_key: String,
    pub user_key: String,
}

pub(crate) struct PanelRuntime { /* lifecycle mutex, child, endpoint, shared secret, fingerprint */ }

impl PanelRuntime {
    pub(crate) fn new(process_guard: Option<Arc<ProcessGuard>>) -> Self;
    pub(crate) async fn ensure_started(&self, layout: BundledLayout, connection: PanelConnection) -> Result<String>;
    pub(crate) async fn register_bootstrap(&self, token: &str, connection: &PanelConnection) -> Result<()>;
    pub(crate) async fn shutdown(&self) -> Result<()>;
}
```

实现约束：

- Panel 端口用现有回环端口分配函数；健康检查 `GET /health` 最长 20 秒。
- Panel 子进程用 bundled Node 执行 `panel/dist/index.js`，当前目录为 runtime `panel`，环境包含 `HOST=127.0.0.1`、动态 `PORT`、`UI_DIST_DIR`、`KNOWLEDGE_SERVICE_URL`、`KNOWLEDGE_AUTH_TOKEN`、`TDAI_PANEL_INSTANCES_JSON`、随机 `TDAI_PANEL_BOOTSTRAP_SECRET`。
- `TDAI_PANEL_INSTANCES_JSON` 只注册当前一个实例，Gateway API Key 仅在子进程环境中传递。
- `ensure_started` 按连接 fingerprint 幂等；配置变化先优雅停止旧 child，再启动新 child。
- `register_bootstrap` 调用 `POST /__grenagent/bootstrap/register`，共享密钥放 Header，User Key 只在回环请求 body 中传递；不写日志。
- 复用 `ProcessGuard`、Job Object、stdin EOF 和现有清理语义。必要的 helper 在 `mod.rs` 改为 `pub(crate)`，不复制第二套 Windows 终止逻辑。
- `panel_url` 只允许 `http://127.0.0.1:<port>/__grenagent/bootstrap#tdai-bootstrap=<token>`，拒绝 query、userinfo、非回环 host。

- [ ] **步骤 4：接入共享 helper 并运行 Rust 测试**

将 `RuntimeProcessGroup`、`spawn_managed_child`、`child_is_running`、`request_graceful_stop`、`wait_for_health` 的可见性调整为 `pub(crate)`，保持现有 MemoryRuntime 行为不变。运行：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml tencentdb::panel
cargo test --manifest-path src-tauri/Cargo.toml tencentdb
```

预期：Panel 新测试通过，原有 TencentDB 测试无回归。

- [ ] **步骤 5：提交任务 2**

```powershell
git add tauri-agent/src-tauri/src/tencentdb/panel.rs tauri-agent/src-tauri/src/tencentdb/mod.rs
git commit -m "feat: manage TencentDB native panel process"
```

## 任务 3：接入 Tauri 启动、关闭和打开命令

**文件：**
- 修改：`tauri-agent/src-tauri/src/commands/tencentdb.rs`
- 修改：`tauri-agent/src-tauri/src/lib.rs`

- [ ] **步骤 1：先写 command 序列化和 URL 安全失败测试**

在现有 `commands/tencentdb.rs` 测试模块加入：

```rust
#[test]
fn panel_open_payload_serializes_without_credentials() {
    let payload = TencentdbPanelOpen {
        url: "http://127.0.0.1:8123/__grenagent/bootstrap#tdai-bootstrap=t".into(),
    };
    let value = serde_json::to_value(payload).unwrap();
    assert_eq!(value["url"], "http://127.0.0.1:8123/__grenagent/bootstrap#tdai-bootstrap=t");
    assert!(!value.to_string().contains("api_key"));
    assert!(!value.to_string().contains("user_key"));
}
```

- [ ] **步骤 2：实现启动编排和 command**

新增返回类型和 command：

```rust
#[derive(Clone, Debug, Serialize)]
pub struct TencentdbPanelOpen { pub url: String }

#[tauri::command]
pub async fn tencentdb_open_panel(
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    memory_runtime: State<'_, Arc<MemoryRuntime>>,
    panel_runtime: State<'_, Arc<PanelRuntime>>,
) -> Result<TencentdbPanelOpen, String> { /* ensure connection, start dependencies, register token, return URL */ }
```

command 顺序固定：读取并 normalize config -> 读取/生成 Gateway API Key -> `ensure_runtime_started`（Local 启动 Core/Knowledge，Remote 执行现有可达性校验）-> 解析 User Key -> `PanelRuntime.ensure_started` -> 生成 UUID token -> `register_bootstrap` -> 返回 URL。任何一步失败都不返回部分 URL。

`ensure_runtime_started` 增加 `&PanelRuntime` 参数，并在应用启动时确保 Panel 已启动；Remote 不启动 Core/Knowledge child。保存连接后沿用现有 restart-required 逻辑，再用新配置刷新 Panel fingerprint。

- [ ] **步骤 3：注册应用状态和退出顺序**

在 `lib.rs` setup 中用同一个 `ProcessGuard` 的 `Arc::clone` 创建并 `manage(Arc<PanelRuntime>)`；invoke handler 注册 `commands::tencentdb::tencentdb_open_panel`。启动任务调用带 PanelRuntime 的 `ensure_runtime_started`。`shutdown_children` 先 `panel_runtime.shutdown()`，再 `memory_runtime.shutdown()`，最后关闭 Pi manager。

- [ ] **步骤 4：运行 Rust 测试和编译检查**

运行：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml tencentdb
cargo check --manifest-path src-tauri/Cargo.toml
```

预期：全部 TencentDB 测试通过，`cargo check` 退出码 0；测试输出和错误文本不包含真实凭据。

- [ ] **步骤 5：提交任务 3**

```powershell
git add tauri-agent/src-tauri/src/commands/tencentdb.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat: expose TencentDB native panel command"
```

## 任务 4：连接设置增加浏览器按钮

**文件：**
- 修改：`tauri-agent/src/lib/tencentdb.ts`
- 修改：`tauri-agent/src/features/tencentdb/ConnectionSettings.tsx`
- 修改：`tauri-agent/src/features/tencentdb/ConnectionSettings.test.tsx`

- [ ] **步骤 1：扩展前端 API 类型**

在 `lib/tencentdb.ts` 增加：

```ts
export interface TencentdbPanelOpen { url: string }

// tencentdbApi
openPanel: () => invoke<TencentdbPanelOpen>('tencentdb_open_panel'),
```

同时从 `tauri-agent/src/features/tencentdb/tencentdbApi.tsx` re-export `TencentdbPanelOpen`，保持组件只从本地 API barrel 取类型。

- [ ] **步骤 2：先写按钮失败测试**

扩展 Vitest mock 和测试：

```tsx
it('opens native panel through system browser', async () => {
  openPanel.mockResolvedValue({ url: 'http://127.0.0.1:8123/__grenagent/bootstrap#tdai-bootstrap=t' });
  render(<ConnectionSettings />);
  fireEvent.click(screen.getByRole('button', { name: '打开原生后台' }));
  await waitFor(() => expect(openUrl).toHaveBeenCalledWith(expect.stringContaining('127.0.0.1')));
});

it('shows panel open error and prevents duplicate calls', async () => {
  openPanel.mockRejectedValue(new Error('Panel unavailable'));
  render(<ConnectionSettings />);
  const button = screen.getByRole('button', { name: '打开原生后台' });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByText('Panel unavailable')).toBeTruthy());
  expect(openPanel).toHaveBeenCalledTimes(1);
});
```

测试 mock `@tauri-apps/plugin-opener` 的 `openUrl`，不得真的启动浏览器。

- [ ] **步骤 3：实现按钮交互**

在 `ConnectionSettings.tsx` 引入 `openUrl`，新增 `openingPanel` 状态和 handler：

```tsx
const openNativePanel = async () => {
  if (openingPanel) return;
  setOpeningPanel(true);
  setMessage(null);
  try {
    const { url } = await tencentdbApi.openPanel();
    await openUrl(url);
  } catch (cause) {
    setMessage(cause instanceof Error ? cause.message : String(cause));
  } finally {
    setOpeningPanel(false);
  }
};
```

在现有保存/测试按钮旁增加 `<Button loading={openingPanel} onClick={() => void openNativePanel()}>打开原生后台</Button>`。按钮不读取或显示任何密钥；错误使用现有 Alert 区域。

- [ ] **步骤 4：运行前端定向测试**

运行：

```powershell
bunx vitest run src/features/tencentdb/ConnectionSettings.test.tsx
```

预期：原有 2 个测试 + 新增 2 个测试全部通过。

- [ ] **步骤 5：提交任务 4**

```powershell
git add tauri-agent/src/lib/tencentdb.ts tauri-agent/src/features/tencentdb/tencentdbApi.tsx tauri-agent/src/features/tencentdb/ConnectionSettings.tsx tauri-agent/src/features/tencentdb/ConnectionSettings.test.tsx
git commit -m "feat: add native TencentDB panel button"
```

## 任务 5：文档、全量验证和交付审查

**文件：**
- 修改：`tauri-agent/README.md`

- [ ] **步骤 1：更新使用文档**

在 TencentDB 运行时说明中写明：应用启动时托管 Core/Knowledge/Panel；连接设置中的「打开原生后台」使用系统浏览器；Remote 模式由本机 Panel 代理远程端点；首次自动登录 token 为一次性短期凭据，User Key 仍由 Panel 本地会话保存。

- [ ] **步骤 2：运行完整验证**

按顺序运行：

```powershell
node --test tauri-agent/scripts/tencentdb-runtime-patches.node-test.mjs
bun run --cwd tauri-agent test --run
cargo test --manifest-path tauri-agent/src-tauri/Cargo.toml
bun run --cwd tauri-agent build
bun run --cwd tauri-agent build:sidecar
git diff --check
git status --short --branch
```

预期：Node、前端、Rust 测试无失败；前端和 sidecar 构建退出码 0；`git diff --check` 无输出。审查 `git status`，确认只包含本功能提交及用户原有未暂存改动。

- [ ] **步骤 3：执行安全审查**

运行：

```powershell
git diff HEAD~5..HEAD --check
git grep -n -I -E "(sk-mem-[A-Za-z0-9]|TDAI_PANEL_BOOTSTRAP_SECRET=.{8,})" HEAD -- tauri-agent/scripts tauri-agent/src tauri-agent/src-tauri/src
```

预期：只出现测试示例值或变量名，不出现真实凭据；bootstrap URL 断言仅允许回环地址和 fragment token。

- [ ] **步骤 4：提交文档并完成审查**

```powershell
git add tauri-agent/README.md
git commit -m "docs: document TencentDB native panel"
git show --stat --oneline HEAD
git status --short --branch
```

最终审查重点：Panel 是否随应用退出、Remote 是否未错误启动本机 Core/Knowledge、URL 是否泄漏凭据、bootstrap 是否单次消费、旧记忆/知识/代码索引实现是否仍未被恢复。
