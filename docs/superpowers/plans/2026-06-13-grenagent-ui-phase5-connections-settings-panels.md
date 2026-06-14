# GrenAgent UI 第 5 期：连接 / 设置 面板（设置存储 + sidecar env 注入打通）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把「设置」「连接」两个占位面板做成真实视图：设置面板用分类表单编辑各 extension 的 env（API key / 开关 / 参数），保存进 GrenAgent 设置存储；spawn sidecar 时把这些 env 注入进去，使 8 个 extension 的配置真正生效。连接面板专注 im-gateway 的开关/端口/Token 配置 + 平台接入指引。

**架构：**
- **设置存储**：`AppState` 增 `settings: HashMap<String,String>`（key=env 名，value=字符串值，空值视为未设）；`AppStateStore` 加 `settings_env()`（读非空项）/`replace_settings()`（整体替换）；新增命令 `get_settings`/`set_settings`。
- **env 注入**：`spawn_pi_client` 增 `env: HashMap<String,String>` 参数，spawn 时 `.envs(env)`；`open_workspace`（已有 `store`）在构造 factory **前** `async` 读 `settings_env()`，闭包捕获后传入。设置改动后由前端 **close+open 当前 workspace** 重启 sidecar 生效。
- **前端**：`lib/pi.ts` 加 `getSettings`/`setSettings` binding；`features/settings/settingsSchema.ts` 数据驱动设置项（分类 + 字段 def）；`SettingsPanel` 左分类 + 右表单（从 schema 生成输入框）+「保存并重启」；`ConnectionsPanel` 专注 im-gateway 3 项 + 平台接入指引（静态）。`ModuleContainer` 接入 settings/connections。

**技术栈：** Rust（`serde`、`tauri_plugin_shell` Command `.envs`）、React 19、`@lobehub/ui`、vitest + @testing-library/react（无 globals/无自动 cleanup；mock 用 `vi.hoisted`）。

---

## 范围

仅第 5 期（连接 + 设置 面板 + env 注入）。完成后：设置面板编辑各 extension env 并持久化、重启 sidecar 后生效；连接面板配置 im-gateway。**不含**：实时网关运行状态查询（无 RPC，仅显示配置态）、API key 加密存储（本期明文存 app-state.json，见备注）、模型/Embedding 的下拉自动发现。

**前置事实（已核实）**
- env 清单（注入目标）：`OPENAI_API_KEY`；KB：`KB_AUTO_INJECT`/`KB_AUTO_TOPK`/`KB_EMBED_API_KEY`/`KB_EMBED_BASE_URL`/`KB_EMBED_MODEL`；记忆：`MEMORY_AUTO_INJECT`/`MEMORY_AUTO_TOPK`/`MEMORY_AUTO_CAPTURE`/`MEMORY_EXTRACT`/`MEMORY_GLOBAL_DB`/`MEMORY_EMBED_API_KEY`/`MEMORY_EMBED_BASE_URL`/`MEMORY_EMBED_MODEL`；图像：`IMAGE_API_KEY`/`IMAGE_BASE_URL`/`IMAGE_MODEL`/`IMAGE_SIZE`；TTS：`TTS_API_KEY`/`TTS_BASE_URL`/`TTS_MODEL`/`TTS_VOICE`/`TTS_FORMAT`；web-fetch：`FETCH_MAX_CHARS`/`FETCH_TIMEOUT_MS`；multi-agent：`SUBAGENT_TIMEOUT_MS`；连接：`IM_GATEWAY`/`IM_GATEWAY_PORT`/`IM_GATEWAY_TOKEN`。
- `AppState`（`state/app_state.rs`）serde 到 app-state.json；`AppStateStore`（`state/store.rs`）`update`/读方法。
- `open_workspace`（`commands/agent.rs:60`）签名已含 `store: State<'_, AppStateStore>`；factory（`mgr.get_or_open(&workspace, move || spawn_pi_client(&app2, ws, &cwd_for_spawn, sink))`）。
- `spawn_pi_client`（`pi/sidecar.rs:47`）spawn 时 `.env("PI_PACKAGE_DIR", &package_dir)`。
- 前端 `ModuleContainer` 已接 chat/knowledge/memory/review/create；settings/connections 仍 `PlaceholderPanel`。`features/common/ManagerLayout.tsx` 可复用（但设置面板用自有两栏布局，见任务 5）。
- im-gateway：`IM_GATEWAY=1` 启用、`IM_GATEWAY_PORT`(8765)、`IM_GATEWAY_TOKEN`；运行状态在 sidecar 内（前端只显示配置 + 重启生效）。

## 文件结构

- 修改 `tauri-agent/src-tauri/src/state/app_state.rs` — `settings` 字段 + 方法 + 单测
- 修改 `tauri-agent/src-tauri/src/state/store.rs` — `settings_env()` / `replace_settings()`
- 修改 `tauri-agent/src-tauri/src/commands/agent.rs` — `get_settings`/`set_settings` 命令；`open_workspace` 注入 env
- 修改 `tauri-agent/src-tauri/src/pi/sidecar.rs` — `spawn_pi_client` 加 `env` 参数
- 修改 `tauri-agent/src-tauri/src/lib.rs` — 注册 2 命令
- 修改 `tauri-agent/src/lib/pi.ts` — `getSettings`/`setSettings` binding + 类型
- 创建 `tauri-agent/src/features/settings/settingsSchema.ts` — 设置项注册表
- 创建 `tauri-agent/src/features/settings/SettingsPanel.tsx` + `SettingsPanel.test.tsx`
- 创建 `tauri-agent/src/features/connections/ConnectionsPanel.tsx` + `ConnectionsPanel.test.tsx`
- 修改 `tauri-agent/src/features/workspace/ModuleContainer.tsx` + `ModuleContainer.test.tsx`

命令：Rust `cargo test`/`cargo build`（src-tauri）；前端 `npx vitest run <file>` / `npx tsc --noEmit`。

---

## 任务 1：Rust — AppState.settings + 存储方法

**文件：**
- 修改：`tauri-agent/src-tauri/src/state/app_state.rs`
- 修改：`tauri-agent/src-tauri/src/state/store.rs`

- [ ] **步骤 1：app_state.rs 加 settings 字段 + 方法**

在 `AppState` 结构体（`approved_workspaces` 字段后）加：

```rust
    /// extension env 设置（key=env 名，value=字符串值；空值视为未设）。
    #[serde(default)]
    pub settings: HashMap<String, String>,
```

在 `impl AppState` 内追加：

```rust
    /// 整体替换 env 设置（前端每次提交完整表单）。
    pub fn replace_settings(&mut self, settings: HashMap<String, String>) {
        self.settings = settings;
    }

    /// 返回要注入 sidecar 的 env（过滤空值/空白）。
    pub fn settings_env(&self) -> HashMap<String, String> {
        self.settings
            .iter()
            .filter(|(_, v)| !v.trim().is_empty())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
```

在 `#[cfg(test)] mod tests` 内追加：

```rust
    #[test]
    fn settings_roundtrip_and_env_filters_empty() {
        let dir = std::env::temp_dir().join(format!("pi-set-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("app-state.json");

        let mut st = AppState::load(&path);
        let mut m = HashMap::new();
        m.insert("OPENAI_API_KEY".to_string(), "sk-x".to_string());
        m.insert("IMAGE_SIZE".to_string(), "  ".to_string()); // 空白 → 不注入
        st.replace_settings(m);
        st.save(&path).unwrap();

        let reloaded = AppState::load(&path);
        assert_eq!(reloaded.settings.get("OPENAI_API_KEY").map(|s| s.as_str()), Some("sk-x"));
        let env = reloaded.settings_env();
        assert_eq!(env.get("OPENAI_API_KEY").map(|s| s.as_str()), Some("sk-x"));
        assert!(!env.contains_key("IMAGE_SIZE")); // 空白被过滤
        std::fs::remove_dir_all(&dir).ok();
    }
```

- [ ] **步骤 2：store.rs 加读写方法**

在 `impl AppStateStore` 内追加：

```rust
    /// 读取要注入 sidecar 的 env 设置（已过滤空值）。
    pub async fn settings_env(&self) -> std::collections::HashMap<String, String> {
        self.inner.lock().await.settings_env()
    }

    /// 读取完整设置表（含空值，供前端表单回填）。
    pub async fn settings_all(&self) -> std::collections::HashMap<String, String> {
        self.inner.lock().await.settings.clone()
    }

    /// 整体替换设置并持久化。
    pub async fn replace_settings(&self, settings: std::collections::HashMap<String, String>) {
        self.update(|st| st.replace_settings(settings)).await;
    }
```

- [ ] **步骤 3：运行 Rust 测试**

运行：`cd tauri-agent/src-tauri && cargo test app_state`
预期：`settings_roundtrip_and_env_filters_empty` 及原有 app_state 测试 PASS。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src-tauri/src/state/app_state.rs tauri-agent/src-tauri/src/state/store.rs
git commit -m "feat(grenagent): add settings store to AppState (phase5)"
```

---

## 任务 2：Rust — settings 命令 + env 注入

**文件：**
- 修改：`tauri-agent/src-tauri/src/pi/sidecar.rs`
- 修改：`tauri-agent/src-tauri/src/commands/agent.rs`
- 修改：`tauri-agent/src-tauri/src/lib.rs`

- [ ] **步骤 1：spawn_pi_client 加 env 参数**

在 `tauri-agent/src-tauri/src/pi/sidecar.rs`，把 `spawn_pi_client` 签名与 spawn 改为（加 `env` 参数，spawn 链上加 `.envs(env)`）：

```rust
pub fn spawn_pi_client(
    app: &tauri::AppHandle,
    workspace: String,
    cwd: &str,
    sink: Arc<dyn crate::pi::sink::EventSink>,
    env: std::collections::HashMap<String, String>,
) -> Result<Arc<PiClient>> {
    let package_dir = pi_package_dir();
    let (mut rx, child) = app
        .shell()
        .sidecar("pi")
        .map_err(|e| anyhow!("sidecar lookup failed: {e}"))?
        .args(["--mode", "rpc"])
        .env("PI_PACKAGE_DIR", &package_dir)
        .envs(env)
        .current_dir(cwd)
        .spawn()
        .map_err(|e| anyhow!("sidecar spawn failed: {e}"))?;
```

（其余函数体不变。）

- [ ] **步骤 2：open_workspace 读 settings 并注入**

在 `tauri-agent/src-tauri/src/commands/agent.rs` 的 `open_workspace` 里，把构造 factory 的那段改为（在 `mgr.get_or_open` 前读 env、闭包捕获）：

```rust
    let app2 = app.clone();
    let ws = workspace.clone();
    let env = store.settings_env().await;
    mgr.get_or_open(&workspace, move || {
        let sink: Arc<dyn EventSink> = Arc::new(TauriSink { app: app2.clone() });
        spawn_pi_client(&app2, ws.clone(), &cwd_for_spawn, sink, env.clone())
    })
    .await
    .map_err(|e| e.to_string())?;
```

- [ ] **步骤 3：加 get_settings/set_settings 命令**

在 `tauri-agent/src-tauri/src/commands/agent.rs` 末尾追加：

```rust
#[tauri::command]
pub async fn get_settings(
    store: State<'_, AppStateStore>,
) -> Result<std::collections::HashMap<String, String>, String> {
    Ok(store.settings_all().await)
}

#[tauri::command]
pub async fn set_settings(
    settings: std::collections::HashMap<String, String>,
    store: State<'_, AppStateStore>,
) -> Result<(), String> {
    store.replace_settings(settings).await;
    Ok(())
}
```

- [ ] **步骤 4：注册命令**

在 `tauri-agent/src-tauri/src/lib.rs` 的 `generate_handler![ ... ]` 里，`commands::create::create_image,` 之后追加：

```rust
            commands::get_settings,
            commands::set_settings,
```

（`get_settings`/`set_settings` 在 `agent.rs`，已被 `pub use agent::*;` 导出，故用 `commands::get_settings`。）

- [ ] **步骤 5：cargo build + 测试**

运行：`cd tauri-agent/src-tauri && cargo build`
预期：编译通过（spawn_pi_client 仅一个调用点，已同步改）。

运行：`cd tauri-agent/src-tauri && cargo test`
预期：全部 PASS（含任务 1 新测试，无回归）。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src-tauri/src/pi/sidecar.rs tauri-agent/src-tauri/src/commands/agent.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(grenagent): settings commands + inject env into sidecar (phase5)"
```

---

## 任务 3：前端 binding + settingsSchema

**文件：**
- 修改：`tauri-agent/src/lib/pi.ts`
- 创建：`tauri-agent/src/features/settings/settingsSchema.ts`

- [ ] **步骤 1：pi.ts 加 binding**

在 `tauri-agent/src/lib/pi.ts` 的 `pi` 对象里 `createImage: ...,` 之后追加：

```ts
  getSettings: () => invoke<Record<string, string>>('get_settings'),
  setSettings: (settings: Record<string, string>) =>
    invoke<void>('set_settings', { settings }),
```

- [ ] **步骤 2：创建 settingsSchema.ts**

`tauri-agent/src/features/settings/settingsSchema.ts`：

```ts
export type FieldType = 'text' | 'password' | 'number' | 'boolean';

export interface SettingField {
  key: string; // env 名
  label: string;
  type: FieldType;
  placeholder?: string;
}

export interface SettingCategory {
  id: string;
  title: string;
  fields: SettingField[];
}

export const SETTINGS_SCHEMA: SettingCategory[] = [
  {
    id: 'general',
    title: '通用 / 模型',
    fields: [{ key: 'OPENAI_API_KEY', label: 'OpenAI API Key（全局兜底）', type: 'password', placeholder: 'sk-...' }],
  },
  {
    id: 'knowledge',
    title: '知识库',
    fields: [
      { key: 'KB_AUTO_INJECT', label: '自动注入（1/0）', type: 'boolean' },
      { key: 'KB_AUTO_TOPK', label: '自动注入条数', type: 'number', placeholder: '3' },
      { key: 'KB_EMBED_API_KEY', label: 'Embedding API Key', type: 'password' },
      { key: 'KB_EMBED_BASE_URL', label: 'Embedding Base URL', type: 'text', placeholder: 'https://api.openai.com/v1' },
      { key: 'KB_EMBED_MODEL', label: 'Embedding 模型', type: 'text', placeholder: 'text-embedding-3-small' },
    ],
  },
  {
    id: 'memory',
    title: '记忆',
    fields: [
      { key: 'MEMORY_AUTO_INJECT', label: '自动注入（1/0）', type: 'boolean' },
      { key: 'MEMORY_AUTO_TOPK', label: '自动召回条数', type: 'number', placeholder: '5' },
      { key: 'MEMORY_AUTO_CAPTURE', label: '捕获“记住：”（1/0）', type: 'boolean' },
      { key: 'MEMORY_EXTRACT', label: '对话提取记忆（1/0）', type: 'boolean' },
      { key: 'MEMORY_EMBED_API_KEY', label: 'Embedding API Key', type: 'password' },
      { key: 'MEMORY_EMBED_MODEL', label: 'Embedding 模型', type: 'text', placeholder: 'text-embedding-3-small' },
    ],
  },
  {
    id: 'image',
    title: '图像生成',
    fields: [
      { key: 'IMAGE_API_KEY', label: 'Image API Key', type: 'password' },
      { key: 'IMAGE_BASE_URL', label: 'Image Base URL', type: 'text', placeholder: 'https://api.openai.com/v1' },
      { key: 'IMAGE_MODEL', label: '模型', type: 'text', placeholder: 'gpt-image-1' },
      { key: 'IMAGE_SIZE', label: '尺寸', type: 'text', placeholder: '1024x1024' },
    ],
  },
  {
    id: 'tts',
    title: '语音 TTS',
    fields: [
      { key: 'TTS_API_KEY', label: 'TTS API Key', type: 'password' },
      { key: 'TTS_BASE_URL', label: 'TTS Base URL', type: 'text', placeholder: 'https://api.openai.com/v1' },
      { key: 'TTS_MODEL', label: '模型', type: 'text', placeholder: 'gpt-4o-mini-tts' },
      { key: 'TTS_VOICE', label: '音色', type: 'text', placeholder: 'alloy' },
      { key: 'TTS_FORMAT', label: '格式', type: 'text', placeholder: 'mp3' },
    ],
  },
  {
    id: 'web',
    title: '网页抓取 / 子代理',
    fields: [
      { key: 'FETCH_MAX_CHARS', label: '抓取最大字符', type: 'number', placeholder: '20000' },
      { key: 'FETCH_TIMEOUT_MS', label: '抓取超时(ms)', type: 'number', placeholder: '15000' },
      { key: 'SUBAGENT_TIMEOUT_MS', label: '子代理超时(ms)', type: 'number', placeholder: '120000' },
    ],
  },
];

/** 连接（im-gateway）字段单列，供 ConnectionsPanel 复用同一存储。 */
export const CONNECTION_FIELDS: SettingField[] = [
  { key: 'IM_GATEWAY', label: '启用网关（1/0）', type: 'boolean' },
  { key: 'IM_GATEWAY_PORT', label: '端口', type: 'number', placeholder: '8765' },
  { key: 'IM_GATEWAY_TOKEN', label: 'Token（可选）', type: 'password' },
];
```

- [ ] **步骤 3：类型检查**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无错误。

- [ ] **步骤 4：Commit**

```bash
git add tauri-agent/src/lib/pi.ts tauri-agent/src/features/settings/settingsSchema.ts
git commit -m "feat(grenagent): settings bindings + schema (phase5)"
```

---

## 任务 4：设置读写 hook（useSettingsForm）

**文件：**
- 创建：`tauri-agent/src/features/settings/useSettingsForm.ts`
- 测试：`tauri-agent/src/features/settings/useSettingsForm.test.ts`

> 把「加载 + 本地编辑 + 保存并重启」逻辑抽成 hook，SettingsPanel 与 ConnectionsPanel 共用。

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/features/settings/useSettingsForm.test.ts`：

```ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSettings, setSettings, closeWorkspace, openWorkspace } = vi.hoisted(() => ({
  getSettings: vi.fn(() => Promise.resolve({ OPENAI_API_KEY: 'sk-old' })),
  setSettings: vi.fn(() => Promise.resolve()),
  closeWorkspace: vi.fn(() => Promise.resolve()),
  openWorkspace: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({
  pi: { getSettings, setSettings, closeWorkspace, openWorkspace },
}));

import { useSettingsForm } from './useSettingsForm';

afterEach(() => vi.clearAllMocks());

describe('useSettingsForm', () => {
  it('loads existing settings', async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.values.OPENAI_API_KEY).toBe('sk-old'));
  });

  it('setValue updates local state', async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.values.OPENAI_API_KEY).toBe('sk-old'));
    act(() => result.current.setValue('OPENAI_API_KEY', 'sk-new'));
    expect(result.current.values.OPENAI_API_KEY).toBe('sk-new');
  });

  it('save persists and restarts sidecar', async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.values.OPENAI_API_KEY).toBe('sk-old'));
    act(() => result.current.setValue('IMAGE_MODEL', 'gpt-image-1'));
    await act(async () => {
      await result.current.save();
    });
    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ IMAGE_MODEL: 'gpt-image-1' }));
    expect(closeWorkspace).toHaveBeenCalledWith('/ws');
    expect(openWorkspace).toHaveBeenCalledWith('/ws');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/settings/useSettingsForm.test.ts`
预期：FAIL，"Cannot find module './useSettingsForm'"。

- [ ] **步骤 3：编写实现**

`tauri-agent/src/features/settings/useSettingsForm.ts`：

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentStoreContext } from '../../stores/AgentStoreContext';
import { pi } from '../../lib/pi';

export interface SettingsForm {
  values: Record<string, string>;
  loading: boolean;
  saving: boolean;
  error: string | null;
  setValue: (key: string, value: string) => void;
  save: () => Promise<void>;
}

export function useSettingsForm(): SettingsForm {
  const { workspace } = useAgentStoreContext();
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef(workspace);
  wsRef.current = workspace;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void pi
      .getSettings()
      .then((s) => {
        if (alive) setValues(s ?? {});
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const setValue = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await pi.setSettings(values);
      // env 在 spawn 时注入：close + open 重启 sidecar 使新设置生效。
      const ws = wsRef.current;
      await pi.closeWorkspace(ws);
      await pi.openWorkspace(ws);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [values]);

  return { values, loading, saving, error, setValue, save };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/settings/useSettingsForm.test.ts`
预期：PASS（3 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/settings/useSettingsForm.ts tauri-agent/src/features/settings/useSettingsForm.test.ts
git commit -m "feat(grenagent): useSettingsForm hook (load/edit/save+restart) (phase5)"
```

---

## 任务 5：SettingsPanel

**文件：**
- 创建：`tauri-agent/src/features/settings/SettingsPanel.tsx`
- 测试：`tauri-agent/src/features/settings/SettingsPanel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/features/settings/SettingsPanel.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSettings, setSettings, closeWorkspace, openWorkspace } = vi.hoisted(() => ({
  getSettings: vi.fn(() => Promise.resolve({ OPENAI_API_KEY: 'sk-old' })),
  setSettings: vi.fn(() => Promise.resolve()),
  closeWorkspace: vi.fn(() => Promise.resolve()),
  openWorkspace: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({
  pi: { getSettings, setSettings, closeWorkspace, openWorkspace },
}));

import { SettingsPanel } from './SettingsPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SettingsPanel', () => {
  it('renders categories and prefills loaded values', async () => {
    render(<SettingsPanel />);
    await waitFor(() => expect(screen.getByTestId('set-cat-general')).toBeTruthy());
    expect(screen.getByTestId('set-cat-knowledge')).toBeTruthy();
    const input = screen.getByTestId('set-field-OPENAI_API_KEY') as HTMLInputElement;
    expect(input.value).toBe('sk-old');
  });

  it('edits a field and saves', async () => {
    render(<SettingsPanel />);
    await waitFor(() => expect(screen.getByTestId('set-field-OPENAI_API_KEY')).toBeTruthy());
    fireEvent.change(screen.getByTestId('set-field-OPENAI_API_KEY'), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByTestId('set-save'));
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ OPENAI_API_KEY: 'sk-new' })),
    );
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/settings/SettingsPanel.test.tsx`
预期：FAIL，"Cannot find module './SettingsPanel'"。

- [ ] **步骤 3：编写实现**

`tauri-agent/src/features/settings/SettingsPanel.tsx`：

```tsx
import { Flexbox } from '@lobehub/ui';
import { useState } from 'react';
import { useSettingsForm } from './useSettingsForm';
import { SETTINGS_SCHEMA, type SettingField } from './settingsSchema';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';

function Field({
  field,
  value,
  onChange,
}: {
  field: SettingField;
  value: string;
  onChange: (v: string) => void;
}) {
  const common = {
    'data-testid': `set-field-${field.key}`,
    value: value ?? '',
    placeholder: field.placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    style: {
      width: '100%',
      padding: '6px 8px',
      borderRadius: 6,
      border,
      background: 'transparent',
      color: 'inherit',
      fontSize: 13,
    } as React.CSSProperties,
  };
  return (
    <Flexbox gap={4} style={{ marginBlockEnd: 12 }}>
      <span style={{ fontSize: 12, color: muted }}>{field.label}</span>
      <input
        {...common}
        type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
      />
    </Flexbox>
  );
}

export function SettingsPanel() {
  const { values, setValue, save, saving, loading, error } = useSettingsForm();
  const [activeCat, setActiveCat] = useState(SETTINGS_SCHEMA[0].id);
  const cat = SETTINGS_SCHEMA.find((c) => c.id === activeCat) ?? SETTINGS_SCHEMA[0];

  return (
    <Flexbox data-testid="settings-panel" style={{ height: '100%', minHeight: 0 }}>
      <Flexbox
        horizontal
        align="center"
        justify="space-between"
        style={{ padding: '10px 14px', borderBottom: border, flex: '0 0 auto' }}
      >
        <span style={{ fontSize: 13 }}>{loading ? '加载中…' : '设置（保存后自动重启 sidecar 生效）'}</span>
        <button
          data-testid="set-save"
          onClick={() => void save()}
          disabled={saving}
          style={{
            padding: '4px 14px',
            borderRadius: 6,
            border,
            cursor: 'pointer',
            background: 'var(--gren-rail-active, rgba(255,255,255,0.08))',
            color: 'inherit',
            fontSize: 12,
          }}
        >
          {saving ? '保存中…' : '保存并重启'}
        </button>
      </Flexbox>
      {error && <div style={{ padding: '6px 14px', fontSize: 12, color: '#f87171' }}>{error}</div>}
      <Flexbox horizontal flex={1} style={{ minHeight: 0 }}>
        <Flexbox style={{ width: 160, flex: '0 0 auto', borderRight: border, overflowY: 'auto' }}>
          {SETTINGS_SCHEMA.map((c) => (
            <button
              key={c.id}
              data-testid={`set-cat-${c.id}`}
              onClick={() => setActiveCat(c.id)}
              style={{
                padding: '8px 14px',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                background: c.id === activeCat ? 'var(--gren-rail-active, rgba(255,255,255,0.08))' : 'transparent',
                color: c.id === activeCat ? 'var(--gren-fg, inherit)' : muted,
                fontSize: 13,
              }}
            >
              {c.title}
            </button>
          ))}
        </Flexbox>
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 16, maxWidth: 560 }}>
          {cat.fields.map((f) => (
            <Field key={f.key} field={f} value={values[f.key] ?? ''} onChange={(v) => setValue(f.key, v)} />
          ))}
        </div>
      </Flexbox>
    </Flexbox>
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/settings/SettingsPanel.test.tsx`
预期：PASS（2 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/settings/SettingsPanel.tsx tauri-agent/src/features/settings/SettingsPanel.test.tsx
git commit -m "feat(grenagent): add SettingsPanel (schema-driven form) (phase5)"
```

---

## 任务 6：ConnectionsPanel

**文件：**
- 创建：`tauri-agent/src/features/connections/ConnectionsPanel.tsx`
- 测试：`tauri-agent/src/features/connections/ConnectionsPanel.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/features/connections/ConnectionsPanel.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getSettings, setSettings, closeWorkspace, openWorkspace } = vi.hoisted(() => ({
  getSettings: vi.fn(() => Promise.resolve({ IM_GATEWAY: '0', IM_GATEWAY_PORT: '8765' })),
  setSettings: vi.fn(() => Promise.resolve()),
  closeWorkspace: vi.fn(() => Promise.resolve()),
  openWorkspace: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../stores/AgentStoreContext', () => ({
  useAgentStoreContext: () => ({ workspace: '/ws' }),
}));
vi.mock('../../lib/pi', () => ({
  pi: { getSettings, setSettings, closeWorkspace, openWorkspace },
}));

import { ConnectionsPanel } from './ConnectionsPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ConnectionsPanel', () => {
  it('renders gateway fields prefilled', async () => {
    render(<ConnectionsPanel />);
    await waitFor(() => expect(screen.getByTestId('conn-field-IM_GATEWAY_PORT')).toBeTruthy());
    expect((screen.getByTestId('conn-field-IM_GATEWAY_PORT') as HTMLInputElement).value).toBe('8765');
    expect(screen.getByText(/Slack/)).toBeTruthy();
  });

  it('saves gateway config', async () => {
    render(<ConnectionsPanel />);
    await waitFor(() => expect(screen.getByTestId('conn-field-IM_GATEWAY_PORT')).toBeTruthy());
    fireEvent.change(screen.getByTestId('conn-field-IM_GATEWAY_PORT'), { target: { value: '9000' } });
    fireEvent.click(screen.getByTestId('conn-save'));
    await waitFor(() =>
      expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ IM_GATEWAY_PORT: '9000' })),
    );
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/connections/ConnectionsPanel.test.tsx`
预期：FAIL，"Cannot find module './ConnectionsPanel'"。

- [ ] **步骤 3：编写实现**

`tauri-agent/src/features/connections/ConnectionsPanel.tsx`：

```tsx
import { Flexbox } from '@lobehub/ui';
import { useSettingsForm } from '../settings/useSettingsForm';
import { CONNECTION_FIELDS } from '../settings/settingsSchema';

const muted = 'var(--gren-fg-muted, #9aa1ac)';
const border = '1px solid var(--gren-border, rgba(255,255,255,0.08))';

const PLATFORMS = [
  { name: 'Slack', hint: '用 Slack Events API/Bolt 适配器把消息 POST 到网关 /message，回复回 replyUrl。' },
  { name: '飞书 / Feishu', hint: '用飞书机器人回调把消息转发到网关 /message。' },
  { name: 'Telegram', hint: '用 Telegram Bot webhook 把消息转发到网关 /message。' },
];

export function ConnectionsPanel() {
  const { values, setValue, save, saving, loading, error } = useSettingsForm();

  return (
    <Flexbox data-testid="connections-panel" style={{ height: '100%', minHeight: 0, overflowY: 'auto' }}>
      <Flexbox
        horizontal
        align="center"
        justify="space-between"
        style={{ padding: '10px 14px', borderBottom: border, flex: '0 0 auto' }}
      >
        <span style={{ fontSize: 13 }}>{loading ? '加载中…' : 'IM 网关（保存后重启生效）'}</span>
        <button
          data-testid="conn-save"
          onClick={() => void save()}
          disabled={saving}
          style={{
            padding: '4px 14px',
            borderRadius: 6,
            border,
            cursor: 'pointer',
            background: 'var(--gren-rail-active, rgba(255,255,255,0.08))',
            color: 'inherit',
            fontSize: 12,
          }}
        >
          {saving ? '保存中…' : '保存并重启'}
        </button>
      </Flexbox>
      {error && <div style={{ padding: '6px 14px', fontSize: 12, color: '#f87171' }}>{error}</div>}

      <div style={{ padding: 16, maxWidth: 560 }}>
        {CONNECTION_FIELDS.map((f) => (
          <Flexbox key={f.key} gap={4} style={{ marginBlockEnd: 12 }}>
            <span style={{ fontSize: 12, color: muted }}>{f.label}</span>
            <input
              data-testid={`conn-field-${f.key}`}
              value={values[f.key] ?? ''}
              placeholder={f.placeholder}
              type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
              onChange={(e) => setValue(f.key, e.target.value)}
              style={{
                width: '100%',
                padding: '6px 8px',
                borderRadius: 6,
                border,
                background: 'transparent',
                color: 'inherit',
                fontSize: 13,
              }}
            />
          </Flexbox>
        ))}

        <div style={{ marginBlockStart: 8, fontSize: 13, fontWeight: 600 }}>平台接入</div>
        <div style={{ fontSize: 12, color: muted, marginBlockEnd: 8 }}>
          网关监听 <code>POST /message {'{ text, replyUrl? }'}</code>，回复回 replyUrl。
        </div>
        {PLATFORMS.map((p) => (
          <Flexbox key={p.name} gap={2} style={{ marginBlockEnd: 10 }}>
            <span style={{ fontSize: 13 }}>{p.name}</span>
            <span style={{ fontSize: 12, color: muted }}>{p.hint}</span>
          </Flexbox>
        ))}
      </div>
    </Flexbox>
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/connections/ConnectionsPanel.test.tsx`
预期：PASS（2 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/connections/ConnectionsPanel.tsx tauri-agent/src/features/connections/ConnectionsPanel.test.tsx
git commit -m "feat(grenagent): add ConnectionsPanel (im-gateway config) (phase5)"
```

---

## 任务 7：ModuleContainer 接入 settings/connections

**文件：**
- 修改：`tauri-agent/src/features/workspace/ModuleContainer.tsx`
- 修改：`tauri-agent/src/features/workspace/ModuleContainer.test.tsx`

- [ ] **步骤 1：更新测试**

把 `ModuleContainer.test.tsx` 整体替换为（在第 4 期版本基础上，加 settings/connections 的 mock 与用例，去掉 placeholder 用例——所有模块都已实现）：

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModuleContainer } from './ModuleContainer';
import { useModuleStore } from '../../stores/moduleStore';

vi.mock('../knowledge/KnowledgePanel', () => ({ KnowledgePanel: () => <div>KB_PANEL</div> }));
vi.mock('../memory/MemoryPanel', () => ({ MemoryPanel: () => <div>MEM_PANEL</div> }));
vi.mock('../review/ReviewPanel', () => ({ ReviewPanel: () => <div>RV_PANEL</div> }));
vi.mock('../create/CreatePanel', () => ({ CreatePanel: () => <div>CR_PANEL</div> }));
vi.mock('../settings/SettingsPanel', () => ({ SettingsPanel: () => <div>SET_PANEL</div> }));
vi.mock('../connections/ConnectionsPanel', () => ({ ConnectionsPanel: () => <div>CONN_PANEL</div> }));

beforeEach(() => {
  useModuleStore.setState({ activeModule: 'chat' });
});

afterEach(() => {
  cleanup();
});

describe('ModuleContainer', () => {
  it('renders chat content when chat module is active', () => {
    render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
    expect(screen.getByText('CHAT_CONTENT')).toBeTruthy();
  });

  const cases: [string, string][] = [
    ['knowledge', 'KB_PANEL'],
    ['memory', 'MEM_PANEL'],
    ['review', 'RV_PANEL'],
    ['create', 'CR_PANEL'],
    ['settings', 'SET_PANEL'],
    ['connections', 'CONN_PANEL'],
  ];
  for (const [mod, text] of cases) {
    it(`renders ${text} for ${mod} module`, () => {
      useModuleStore.setState({ activeModule: mod as never });
      render(<ModuleContainer chat={<div>CHAT_CONTENT</div>} />);
      expect(screen.getByText(text)).toBeTruthy();
    });
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/workspace/ModuleContainer.test.tsx`
预期：FAIL（settings/connections 仍 placeholder）。

- [ ] **步骤 3：修改 ModuleContainer（所有模块均有实体面板，移除 PlaceholderPanel）**

把 `tauri-agent/src/features/workspace/ModuleContainer.tsx` 整体替换为：

```tsx
import type { ReactNode } from 'react';
import { useModuleStore } from '../../stores/moduleStore';
import { KnowledgePanel } from '../knowledge/KnowledgePanel';
import { MemoryPanel } from '../memory/MemoryPanel';
import { ReviewPanel } from '../review/ReviewPanel';
import { CreatePanel } from '../create/CreatePanel';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ConnectionsPanel } from '../connections/ConnectionsPanel';

export function ModuleContainer({ chat }: { chat: ReactNode }) {
  const activeModule = useModuleStore((s) => s.activeModule);
  switch (activeModule) {
    case 'chat':
      return <>{chat}</>;
    case 'knowledge':
      return <KnowledgePanel />;
    case 'memory':
      return <MemoryPanel />;
    case 'review':
      return <ReviewPanel />;
    case 'create':
      return <CreatePanel />;
    case 'settings':
      return <SettingsPanel />;
    case 'connections':
      return <ConnectionsPanel />;
    default:
      return <>{chat}</>;
  }
}
```

> 注：`PlaceholderPanel` 不再被 `ModuleContainer` 使用（7 模块全部实装）。文件保留（无需删除），避免影响其它引用；如确认无其它引用可在收尾单独清理。

- [ ] **步骤 4：测试 + 类型 + 全量**

运行：`cd tauri-agent && npx vitest run src/features/workspace/ModuleContainer.test.tsx`（预期 7 passed）
运行：`cd tauri-agent && npx tsc --noEmit`（无错误）
运行：`cd tauri-agent && npx vitest run`（全部 PASS）

- [ ] **步骤 5：手动验证（Tauri GUI）**

`cd tauri-agent && npm run tauri dev`：点「设置」分类编辑（如填 `OPENAI_API_KEY`），点「保存并重启」→ sidecar 重启；再触发需要 key 的工具（如 `generate_image`）确认 env 生效。点「连接」配置 `IM_GATEWAY=1`/端口，保存重启后 `/imgateway` 应显示监听中。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/workspace/ModuleContainer.tsx tauri-agent/src/features/workspace/ModuleContainer.test.tsx
git commit -m "feat(grenagent): wire Settings/Connections panels; all 7 modules live (phase5)"
```

---

## 自检

**1. 规格覆盖度（设计 §3、§4.6、§4.7、§8、§10 第 5 期）：**
- 设置面板：左分类 + 右表单（各 extension env），落点 GrenAgent 设置存储（§4.7）→ 任务 1（存储）+ 3（schema）+ 5（面板）✓
- spawn sidecar 注入 env（§8）→ 任务 2 ✓
- 连接面板：im-gateway 开关/端口/Token + 平台接入指引（§4.6）→ 任务 6 ✓
- 设置改动生效：close+open 重启 sidecar → 任务 4 `useSettingsForm.save` ✓
- 接入模块容器、7 模块全实装（§3/§7）→ 任务 7 ✓
- 无 emoji（§9.1）→ 表单/文本，无 emoji ✓

**2. 占位符扫描：** 无 TODO/待定。每步含完整代码、命令、预期。`PlaceholderPanel` 保留但不再被 ModuleContainer 引用（已注明）。

**3. 类型一致性：**
- Rust `settings: HashMap<String,String>`、命令 `get_settings`/`set_settings`（任务 1/2）与 `lib.rs` 注册、`pi.ts` `getSettings`/`setSettings`（任务 3）一致；`spawn_pi_client` 新增 `env` 参数（任务 2）唯一调用点（open_workspace）已同步。
- `useSettingsForm` 暴露 `values/setValue/save/saving/loading/error`（任务 4）与 SettingsPanel（任务 5）、ConnectionsPanel（任务 6）调用一致。
- `SettingField`/`SETTINGS_SCHEMA`/`CONNECTION_FIELDS`（任务 3）与任务 5/6 渲染一致。
- `ModuleContainer` settings→SettingsPanel、connections→ConnectionsPanel（任务 7）与任务 5/6 导出名一致。
- `pi.closeWorkspace`/`openWorkspace`（既有）被 `useSettingsForm.save` 复用，签名 `(workspace)` 一致。

## 备注

- **API key 明文存储**：本期存于 app-state.json 明文（GrenAgent 本地桌面应用）。生产可升级系统 keychain / 加密；列为后续安全增强（设计 §4.7「连接/安全」）。
- **设置生效靠重启 sidecar**：env 在 spawn 时注入，故保存后 close+open 当前 workspace。仅重启当前 workspace 的 sidecar；多 workspace 场景其余在各自下次 open 时读最新设置。
- **连接面板仅配置态**：im-gateway 运行状态在 sidecar 内、无 RPC 查询；面板显示配置 + 重启生效 + 平台指引，不显示实时“监听中”。如需实时状态可后续加 RPC method 或解析 `/imgateway` 命令输出。
- **env 注入面向所有 8 extension**：知识库/记忆/图像/TTS/抓取/子代理/连接的参数均可在此配置，一处管理。
- **PlaceholderPanel 清理**：7 模块全实装后该组件不再被使用，保留文件以免误删其它引用；确认无引用后可单独删除。
