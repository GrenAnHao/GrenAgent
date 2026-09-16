# GrenAgent UI 第 7 期：extension 增强（受限项落地）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 补齐第 6 期标注的「受限项」：① 审查 diff 片段（详情显示该文件 git diff）；② 记忆 手动添加 / 提升为全局（extension 加命令）；③（附录，高成本）记忆来源标签 + 命中统计、im-gateway 实时状态。

**务实分级（关键）：**
- **A. 审查 diff 片段** —— 纯 Rust + 前端，**不改 extension、不重建 sidecar**（用 git 取选中文件的 diff）。最可行，先做。
- **B. 记忆 手动添加 / 提升全局** —— 给 `long-term-memory` extension 加 `/memory add` 与 `/memory promote` 命令，前端按钮经 `runCommand` 调用；**需重建 sidecar**（bun 编译，已验证流程）。
- **C. 高成本项（本期附录，仅给路径，不实现）**：记忆来源（manual/capture/extract）需 store schema 加 `source` 列 + 三处写入埋点；命中统计需 `recall` 时写 `hitCount`（每次召回写 db，性能/复杂度高）；im-gateway 实时状态需把 handle 状态经 `/imgateway` 输出解析或加机制。均需改 extension schema/逻辑 + 重建 + 数据迁移，建议单独评估。

**技术栈：** Rust（`std::process::Command` 跑 git，或复用 `commands/git.rs`）、TypeScript（extension `long-term-memory/index.ts`）、bun（重建 sidecar）、React 19、vitest。

---

## 范围

第 7 期：审查 diff（A）+ 记忆 手动添加/提升全局（B）。C 类（来源/命中/gateway 实时）列附录路径，不在本期实现（成本高、需 schema 迁移）。

**前置事实（已核实）**
- `commands/git.rs` 已有 `get_git_diff`（看现有签名；本期加按文件取 diff）。
- 审查 `review_notes` 有 `file` + `line`；选中后可对 `file` 取 git diff 展示。
- `long-term-memory/index.ts` 的 `/memory` 命令现有 list/forget/clear；`MemoryStore.save(text, category, config)` 可存（手动添加 category='manual'）；提升全局 = 从 project 读该条 → global.save → project.forget。
- 第 6 期 `pi.runCommand(ws, cmd)` 可发 extension 命令；重建 sidecar 用 `node scripts/build-sidecar.mjs`（已修，含 extensions 依赖安装）。
- 重建前需关闭 GrenAgent（exe 占用）。

## 文件结构

**A 审查 diff：**
- 修改 `tauri-agent/src-tauri/src/commands/git.rs` — 加 `git_file_diff(workspace, file)`（+ 单测）
- 修改 `tauri-agent/src-tauri/src/lib.rs` — 注册
- 修改 `tauri-agent/src/lib/pi.ts` — `gitFileDiff` binding
- 修改 `tauri-agent/src/features/review/ReviewPanel.tsx`（+ .test）— 详情显示 diff

**B 记忆命令：**
- 修改 `extensions/long-term-memory/index.ts` — `/memory add <text>`、`/memory promote <id>`
- 重建 sidecar
- 修改 `tauri-agent/src/features/memory/MemoryPanel.tsx`（+ .test）— 手动添加 / 提升全局按钮

---

## 任务 1：Rust — git_file_diff

**文件：** 修改 `tauri-agent/src-tauri/src/commands/git.rs` + `lib.rs`

- [ ] **步骤 1：看现有 git.rs 结构**

先读 `commands/git.rs`，复用其 workspace→cwd 解析与 git 调用方式（如已有运行 git 的 helper）。

- [ ] **步骤 2：加 git_file_diff（纯函数 + 命令 + 单测）**

在 `git.rs` 追加（用 `std::process::Command` 跑 `git diff -- <file>`；纯函数接受 cwd + file，便于测试用真实临时 git 仓库）：

```rust
fn run_file_diff(cwd: &std::path::Path, file: &str) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(["diff", "--", file])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git diff failed: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
pub fn git_file_diff(workspace: String, file: String) -> Result<String, String> {
    let cwd = crate::commands::sessions::resolve_workspace_dir(&workspace)?;
    run_file_diff(&cwd, &file)
}
```

单测：用 `std::env::temp_dir` 建临时目录 `git init`、写文件、改动、`git add`，断言 `run_file_diff` 含 diff 标记。（若 CI 无 git 用户名配置，diff 不依赖 commit，仅工作区改动即可。）

```rust
#[cfg(test)]
mod file_diff_tests {
    use super::*;
    fn git(cwd: &std::path::Path, args: &[&str]) {
        std::process::Command::new("git").args(args).current_dir(cwd).output().unwrap();
    }
    #[test]
    fn diffs_a_modified_file() {
        let dir = std::env::temp_dir().join(format!("gdiff-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "x"]);
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        let d = run_file_diff(&dir, "a.txt").unwrap();
        assert!(d.contains("a.txt"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

- [ ] **步骤 3：注册** — `lib.rs` 的 handler 加 `commands::git::git_file_diff,`

- [ ] **步骤 4：cargo test + build**

`cd tauri-agent/src-tauri && cargo test file_diff && cargo build`

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src-tauri/src/commands/git.rs tauri-agent/src-tauri/src/lib.rs
git commit -m "feat(grenagent): add git_file_diff command (phase7)"
```

---

## 任务 2：前端 — 审查详情显示 diff

**文件：** 修改 `tauri-agent/src/lib/pi.ts` + `ReviewPanel.tsx`（+ .test）

- [ ] **步骤 1：pi binding** — `lib/pi.ts` 加：

```ts
  gitFileDiff: (workspace: string, file: string) =>
    invoke<string>('git_file_diff', { workspace, file }),
```

- [ ] **步骤 2：测试（先红）** — `ReviewPanel.test.tsx` mock 加 `gitFileDiff: vi.fn(()=>Promise.resolve('@@ -1 +1 @@\n-one\n+two'))`，追加：

```tsx
it('loads file diff in detail when a finding is selected', async () => {
  render(<ReviewPanel />);
  await waitFor(() => expect(screen.getByTestId('rv-note-n1')).toBeTruthy());
  fireEvent.click(screen.getByTestId('rv-note-n1'));
  await waitFor(() => expect(gitFileDiff).toHaveBeenCalledWith('/ws', 'a.ts'));
  await waitFor(() => expect(screen.getByTestId('rv-diff').textContent).toContain('two'));
});
```

- [ ] **步骤 3：实现** — `ReviewPanel` 加 `diff` state + selected 变化时 `pi.gitFileDiff(workspace, selected.file)`；详情区在 message 下加 `<pre data-testid="rv-diff">`（有 diff 时）：

```tsx
  const [diff, setDiff] = useState<string>('');
  useEffect(() => {
    if (!selected) { setDiff(''); return; }
    let alive = true;
    void pi.gitFileDiff(workspace, selected.file)
      .then((d) => { if (alive) setDiff(d); })
      .catch(() => { if (alive) setDiff(''); });
    return () => { alive = false; };
  }, [workspace, selected]);
```

detail 内（message 后）：

```tsx
      {diff && (
        <pre data-testid="rv-diff" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, whiteSpace: 'pre-wrap', border, borderRadius: 8, padding: 10, color: muted, maxHeight: 240, overflow: 'auto' }}>
          {diff}
        </pre>
      )}
```

- [ ] **步骤 4：测试通过** — `npx vitest run src/features/review/ReviewPanel.test.tsx`（5 passed）

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/lib/pi.ts tauri-agent/src/features/review/ReviewPanel.tsx tauri-agent/src/features/review/ReviewPanel.test.tsx
git commit -m "feat(grenagent): show git diff in review detail (phase7)"
```

---

## 任务 3：extension — /memory add 与 /memory promote

**文件：** 修改 `extensions/long-term-memory/index.ts`

- [ ] **步骤 1：在 `/memory` 命令 handler 加两个子命令**

在 `registerCommand("memory", ...)` 的 handler 内（`if (sub === "list")` 前后）加：

```ts
      if (sub === "add") {
        const text = parts.slice(1).join(" ").trim();
        if (!text) { ctx.ui.notify("Usage: /memory add <text>", "warn"); return; }
        const config = resolveEmbeddingConfig();
        const { id } = await project.save(text, "manual", config);
        ctx.ui.notify(`Saved project memory [${id}]: ${text}`, "success");
        return;
      }

      if (sub === "promote") {
        const id = parts[1];
        if (!id) { ctx.ui.notify("Usage: /memory promote <id>", "warn"); return; }
        const all = project.list(1000);
        const m = all.find((x) => x.id === id);
        if (!m) { ctx.ui.notify(`No project memory ${id}.`, "warn"); return; }
        const config = resolveEmbeddingConfig();
        await global.save(m.text, m.category ?? null, config);
        project.forget(id);
        ctx.ui.notify(`Promoted ${id} to global memory.`, "success");
        return;
      }
```

（`MemoryStore.list/save/forget` 均已存在；`/memory clear` 等保留。更新命令 description 文案含 add/promote。）

- [ ] **步骤 2：typecheck extension（可选）**

`cd extensions && npx tsc --noEmit`（若配置了 tsconfig；否则跳过，靠 bun 编译报错兜底）。

- [ ] **步骤 3：重建 sidecar**

> ⚠️ 先关闭正在运行的 GrenAgent（exe 占用）。

`cd tauri-agent && node scripts/build-sidecar.mjs`
预期：bun 编译成功，新 `pi-*.exe` 生成。

- [ ] **步骤 4：冒烟测试新二进制**

`$env:PI_PACKAGE_DIR=(Resolve-Path "src-tauri/binaries").Path; '{"type":"get_state","id":"t"}' | & ".\src-tauri\binaries\pi-x86_64-pc-windows-msvc.exe" --mode rpc 2>&1 | Select-Object -First 5`
预期：返回 get_state success（无崩溃）。

- [ ] **步骤 5：Commit**

```bash
git add extensions/long-term-memory/index.ts
git commit -m "feat(extensions): /memory add and /memory promote commands (phase7)"
```

---

## 任务 4：前端 — 记忆 手动添加 / 提升全局按钮

**文件：** 修改 `tauri-agent/src/features/memory/MemoryPanel.tsx`（+ .test）

- [ ] **步骤 1：测试（先红）** — mock 已有 `runCommand`；追加：

```tsx
it('adds a memory via /memory add', async () => {
  vi.spyOn(window, 'prompt').mockReturnValue('用户喜欢深色');
  render(<MemoryPanel />);
  await waitFor(() => expect(screen.getByTestId('mem-add')).toBeTruthy());
  fireEvent.click(screen.getByTestId('mem-add'));
  await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/memory add 用户喜欢深色'));
});

it('promotes a project memory to global', async () => {
  render(<MemoryPanel />);
  await waitFor(() => expect(screen.getByTestId('mem-item-project-p1')).toBeTruthy());
  fireEvent.click(screen.getByTestId('mem-item-project-p1'));
  fireEvent.click(screen.getByTestId('mem-promote'));
  await waitFor(() => expect(runCommand).toHaveBeenCalledWith('/ws', '/memory promote p1'));
});
```

- [ ] **步骤 2：运行验证失败** — `npx vitest run src/features/memory/MemoryPanel.test.tsx`

- [ ] **步骤 3：实现** — header 加「手动添加」按钮（`mem-add`，`window.prompt` 取文本 → `/memory add <text>` → reload）；详情区 selected 且 `scope==='project'` 时加「提升为全局」按钮（`mem-promote` → `/memory promote <id>` → reload）。import `Plus`、`ArrowUp`（lucide）。

```tsx
  const onAdd = useCallback(async () => {
    const text = window.prompt('输入要记住的内容：');
    if (!text?.trim()) return;
    await pi.runCommand(workspace, `/memory add ${text.trim()}`);
    reload();
  }, [workspace, reload]);

  const onPromote = useCallback(async () => {
    if (!selected || selected.scope !== 'project') return;
    await pi.runCommand(workspace, `/memory promote ${selected.id}`);
    setSelectedKey(null);
    reload();
  }, [workspace, selected, reload]);
```

header（mem-clear 前）加 `<ActionIcon data-testid="mem-add" icon={Plus} size="small" title="手动添加" onClick={() => void onAdd()} />`；detail 删除按钮旁（selected.scope==='project' 时）加 `<ActionIcon data-testid="mem-promote" icon={ArrowUp} size="small" title="提升为全局" onClick={() => void onPromote()} />`。

- [ ] **步骤 4：测试通过** — `npx vitest run src/features/memory/MemoryPanel.test.tsx`（7 passed）

- [ ] **步骤 5：手动验证 + Commit**

`npm run tauri dev`：记忆面板「手动添加」输入文本 → 新增项目记忆；选项目记忆「提升为全局」→ 移到全局。

```bash
git add tauri-agent/src/features/memory/MemoryPanel.tsx tauri-agent/src/features/memory/MemoryPanel.test.tsx
git commit -m "feat(grenagent): memory manual-add and promote-to-global (phase7)"
```

---

## 自检

**1. 覆盖度：** 审查 diff（A）→ 任务 1+2 ✓；记忆 手动添加/提升全局（B）→ 任务 3+4 ✓。C 类（来源/命中/gateway）见附录，明确不在本期。

**2. 占位符扫描：** A/B 任务含完整代码、命令、预期；C 类在附录标注为「不实现，仅路径」。

**3. 类型一致性：** `git_file_diff`/`gitFileDiff`、`/memory add|promote`、`onAdd/onPromote` 跨 Rust/extension/前端/测试一致；记忆 add 用 category='manual' 与现有 save 签名一致。

## 附录：C 类高成本项（不在本期，仅记录路径与代价）

- **记忆来源标签（manual/capture/extract）**：`MemoryStore` 表加 `source TEXT` 列；`save` 增 `source` 参；index.ts 三处写入（手动命令='manual'、捕获='capture'、提取='extract'）；Rust `mem_list` 读新列；前端显示标签。**需 schema 迁移 + 重建**。代价中。
- **命中统计（被召回 N 次）**：表加 `hitCount INTEGER`；`recall` 命中后 `UPDATE ... SET hitCount=hitCount+1`（每次召回写库，注意并发/性能）；Rust 读 + 前端显示。**需 schema + recall 写路径改 + 重建**。代价高（召回写库影响每轮注入）。
- **im-gateway 实时状态**：sidecar 内 handle 状态无 RPC 暴露；可选 ① `/imgateway` 输出经 `extension_ui_request(notify)` 回前端解析（不稳定）；② 给 gateway 加一个轻量健康检查端口由 Rust 探测。**需机制设计 + 重建**。代价高、收益有限（连接面板已显示配置态）。

> 建议：A、B 先做（本计划）；C 类按真实需求单独立项。
