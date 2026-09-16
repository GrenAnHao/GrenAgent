# README 预览图融合实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `images/` 中 8 张截图以语义化文件名纳入根目录 `README.md`——Hero 代码图谱 + 7 条特性图文交替 table +「此外还支持」纯文字段。

**架构：** 先用 `git mv` 重命名 8 个 hash 文件为语义化名称；再替换 `README.md` 的 `## 特性` 章节（简介段后插入 Hero，删除原 9 条 bullet）；其余章节（架构、快速开始等）一字不改。

**技术栈：** Git、GitHub Flavored Markdown（HTML `<table>` + `<img>`）、PowerShell 或 Bash（文件重命名与路径校验）。

**规格：** `docs/superpowers/specs/2026-06-20-readme-preview-design.md`

**工作目录：** 仓库根目录 `D:/OneDrive/Project Files/Pi`（以下路径均相对于根目录）。

---

## 文件结构

| 路径 | 操作 | 职责 |
|------|------|------|
| `images/hero-code-graph.jpg` | 重命名 | Hero — 代码图谱全景 |
| `images/workspace-context.png` | 重命名 | 特性 1 — 多会话与项目管理 |
| `images/chat-diagram.png` | 重命名 | 特性 2 — 流式对话 |
| `images/code-index.png` | 重命名 | 特性 3 — 代码智能 |
| `images/git-graph.png` | 重命名 | 特性 4 — Git 集成 |
| `images/providers.png` | 重命名 | 特性 5 — 多供应商 |
| `images/mcp-servers.png` | 重命名 | 特性 6 — MCP 扩展 |
| `images/skills.png` | 重命名 | 特性 7 — Skills 工作流 |
| `README.md` | 修改 | 插入 Hero；重写 `## 特性` |
| `images/` 内其余 7 个 hash 文件 | 不动 | 备用，不删不改 |

---

## 任务 1：重命名 8 张截图

**文件：**
- 修改：`images/` 下 8 个 hash 文件名 → 语义化名称（`git mv`）

- [ ] **步骤 1：确认源文件存在**

在仓库根目录运行：

```powershell
$files = @(
  @{ src = "images/8bf01f949a834c9348c89183db68531fafc5fd16_2_1035x654.jpg"; dst = "images/hero-code-graph.jpg" },
  @{ src = "images/d10b2fca34f498411fbc2097e37d34c87e3e024f_2_1035x655.png"; dst = "images/workspace-context.png" },
  @{ src = "images/711cd34dcbd81d8f3015cf8f2a3f21c4def3080c_2_1035x655.png"; dst = "images/chat-diagram.png" },
  @{ src = "images/3564a6d45c2740b2d6056a638a64e5e2821387f8_2_1035x654.png"; dst = "images/code-index.png" },
  @{ src = "images/102623f858b57166cc46de4416fdc5d8b4eadae0_2_1035x654.png"; dst = "images/git-graph.png" },
  @{ src = "images/beacaae2d4fdc62c46c835222a46704476b9f12c_2_1035x654.png"; dst = "images/providers.png" },
  @{ src = "images/0cee30d965af04ae10d79a3c32fce838fc6f1155_2_1035x654.png"; dst = "images/mcp-servers.png" },
  @{ src = "images/906d682e782216582d362c0b9956d4e0e26b2220_2_1035x654.png"; dst = "images/skills.png" }
)
foreach ($f in $files) {
  if (-not (Test-Path $f.src)) { throw "Missing: $($f.src)" }
}
Write-Host "All 8 source files exist."
```

预期：输出 `All 8 source files exist.`，无 throw。

- [ ] **步骤 2：git mv 重命名**

```powershell
git mv "images/8bf01f949a834c9348c89183db68531fafc5fd16_2_1035x654.jpg" "images/hero-code-graph.jpg"
git mv "images/d10b2fca34f498411fbc2097e37d34c87e3e024f_2_1035x655.png" "images/workspace-context.png"
git mv "images/711cd34dcbd81d8f3015cf8f2a3f21c4def3080c_2_1035x655.png" "images/chat-diagram.png"
git mv "images/3564a6d45c2740b2d6056a638a64e5e2821387f8_2_1035x654.png" "images/code-index.png"
git mv "images/102623f858b57166cc46de4416fdc5d8b4eadae0_2_1035x654.png" "images/git-graph.png"
git mv "images/beacaae2d4fdc62c46c835222a46704476b9f12c_2_1035x654.png" "images/providers.png"
git mv "images/0cee30d965af04ae10d79a3c32fce838fc6f1155_2_1035x654.png" "images/mcp-servers.png"
git mv "images/906d682e782216582d362c0b9956d4e0e26b2220_2_1035x654.png" "images/skills.png"
```

若 `images/` 尚未被 git 跟踪，先 `git add images/` 再 mv；或改用 `Move-Item` 后 `git add` 新文件并 `git rm` 旧路径。

- [ ] **步骤 3：验证 8 个目标路径**

```powershell
@(
  "images/hero-code-graph.jpg",
  "images/workspace-context.png",
  "images/chat-diagram.png",
  "images/code-index.png",
  "images/git-graph.png",
  "images/providers.png",
  "images/mcp-servers.png",
  "images/skills.png"
) | ForEach-Object {
  if (-not (Test-Path $_)) { throw "Missing after rename: $_" }
  Write-Host "OK $_"
}
```

预期：8 行 `OK images/...`。

- [ ] **步骤 4：Commit**

```powershell
git add images/
git commit -m "chore(readme): 重命名预览截图为语义化文件名"
```

---

## 任务 2：更新 README.md

**文件：**
- 修改：`README.md`（第 3 行后插入 Hero；第 5–15 行 `## 特性` 整段替换）

- [ ] **步骤 1：在简介段落后插入 Hero**

定位 `README.md` 第 3 行（简介段落）与第 5 行 `## 特性` 之间，插入：

```markdown

<p align="center">
  <img src="images/hero-code-graph.jpg" alt="代码图谱 · 227 个文件 · 674 条依赖" width="100%">
</p>

```

简介段落（第 3 行）保持原文不变：

```markdown
本地优先的桌面 AI 编码 Agent。基于 Pi 运行时（`@earendil-works/pi-coding-agent`），把对话、工具调用、代码智能、知识库与记忆整合进一个 Tauri 桌面应用，全程在本地运行。
```

- [ ] **步骤 2：替换 `## 特性` 整节**

删除原第 5–15 行（`## 特性` 标题 + 9 条 `-` bullet），替换为以下完整内容（从 `## 特性` 到「此外还支持」段末，`## 架构` 之前）：

```markdown
## 特性

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>多会话与项目管理</strong><br>
      按项目分组的侧栏，支持置顶、重命名、右键菜单、在资源管理器中打开。
    </td>
    <td width="50%">
      <img src="images/workspace-context.png" alt="多会话与项目管理" width="100%">
    </td>
  </tr>
</table>

<p></p>

<table>
  <tr>
    <td width="50%">
      <img src="images/chat-diagram.png" alt="流式对话" width="100%">
    </td>
    <td width="50%" valign="top">
      <strong>流式对话</strong><br>
      工具卡片、Mermaid 渲染、Plan / Questions / Answer 卡片、子代理（Sub-Agent）内联视图。
    </td>
  </tr>
</table>

<p></p>

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>代码智能</strong><br>
      内置 CodeGraph，离线、零配置，基于 tree-sitter 与 SQLite。
    </td>
    <td width="50%">
      <img src="images/code-index.png" alt="代码智能" width="100%">
    </td>
  </tr>
</table>

<p></p>

<table>
  <tr>
    <td width="50%">
      <img src="images/git-graph.png" alt="Git 集成" width="100%">
    </td>
    <td width="50%" valign="top">
      <strong>Git 集成</strong><br>
      改动 diff、分支切换、提交图谱，与 workspace 上下文一体。
    </td>
  </tr>
</table>

<p></p>

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>多供应商</strong><br>
      多模型供应商配置与模型同步，生图、TTS、Embedding 等能力可分别选源。
    </td>
    <td width="50%">
      <img src="images/providers.png" alt="多供应商" width="100%">
    </td>
  </tr>
</table>

<p></p>

<table>
  <tr>
    <td width="50%">
      <img src="images/mcp-servers.png" alt="MCP 扩展" width="100%">
    </td>
    <td width="50%" valign="top">
      <strong>MCP 扩展</strong><br>
      连接外部 MCP server，工具以 <code>mcp__&lt;server&gt;__&lt;tool&gt;</code> 暴露给 Agent，面板内测试连接与权限配置。
    </td>
  </tr>
</table>

<p></p>

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>Skills 工作流</strong><br>
      从 <code>~/.agents/skills</code> 加载技能，<code>/skill:name</code> 调用，面板内启用/禁用。
    </td>
    <td width="50%">
      <img src="images/skills.png" alt="Skills 工作流" width="100%">
    </td>
  </tr>
</table>

此外还支持：

- **知识库 RAG** — 文件分块后做向量或关键词检索，面板内用原生文件选择器添加文档。
- **长期记忆** — 跨会话的记忆抽取与检索。
- **用量统计** — 按天、模型、项目聚合 Token 与费用。
- **终端 Dock** — 终端 tab 容器，子代理会话独立成 tab。
- **IM 接入** — 微信（ilink 官方 bot）扫码登录，手机遥控 Agent；「连接」面板展示登录状态与会话只读镜像。

```

注意：MCP 条目中 `mcp__<server>__<tool>` 在 HTML table 内须写成 `mcp__&lt;server&gt;__&lt;tool&gt;`，否则 GitHub 会把尖括号当 HTML 标签吞掉。

- [ ] **步骤 3：确认 `## 架构` 及之后章节未改动**

`## 架构` 起至文件末尾应与修改前完全一致（第 17 行起原内容）。快速 diff：

```powershell
git diff README.md | Select-String "^[\+\-]## "
```

预期：仅出现 `-## 特性` 与 `+## 特性`，不应出现 `-## 架构` 或其他章节标题变更。

- [ ] **步骤 4：Commit**

```powershell
git add README.md
git commit -m "docs(readme): 添加产品预览图与特性图文排版"
```

---

## 任务 3：验证

**文件：**
- 检查：`README.md`、`images/` 引用路径

- [ ] **步骤 1：README 引用的 8 张图片均存在**

```powershell
Select-String -Path README.md -Pattern 'src="images/[^"]+"' -AllMatches |
  ForEach-Object { $_.Matches } |
  ForEach-Object { $_.Value -replace 'src="', '' -replace '"', '' } |
  Sort-Object -Unique |
  ForEach-Object {
    if (-not (Test-Path $_)) { throw "Broken ref: $_" }
    Write-Host "OK $_"
  }
```

预期：8 行 `OK images/...`，无 throw。

- [ ] **步骤 2：原 9 条特性能力覆盖检查**

确认下列关键词在 README 中各出现至少一次（7 条 table +「此外还支持」合计覆盖原 9 条）：

| 原特性 | 出现位置 |
|--------|----------|
| 多会话与项目管理 | table 1 |
| 流式对话 | table 2 |
| 知识库 RAG | 此外还支持 |
| 长期记忆 | 此外还支持 |
| 代码智能 | table 3 |
| 多供应商 | table 5 |
| 用量统计 | 此外还支持 |
| 终端 Dock | 此外还支持 |
| IM 接入 | 此外还支持 |

```powershell
$terms = @(
  "多会话与项目管理", "流式对话", "知识库 RAG", "长期记忆", "代码智能",
  "多供应商", "用量统计", "终端 Dock", "IM 接入"
)
$content = Get-Content README.md -Raw
foreach ($t in $terms) {
  if ($content -notmatch [regex]::Escape($t)) { throw "Missing term: $t" }
  Write-Host "OK $t"
}
```

预期：9 行 `OK ...`。

- [ ] **步骤 3：本地 Markdown 预览（可选）**

在 VS Code / Cursor 中对 `README.md` 打开 Markdown 预览（Ctrl+Shift+V），目视确认：

- Hero 图在标题与特性之间全宽显示
- 7 条 table 左右交替（1/3/5/7 文字左，2/4/6 图左）
- 「此外还支持」5 条 bullet 在 table 与 `## 架构` 之间

- [ ] **步骤 4：更新规格文档状态（可选）**

将 `docs/superpowers/specs/2026-06-20-readme-preview-design.md` 第 3 行状态改为：

```markdown
> 状态：已实现。规格：`docs/superpowers/plans/2026-06-20-readme-preview.md`
```

可与 README commit 一并提交或单独 commit。

---

## 规格覆盖度自检

| 规格章节 | 对应任务 |
|----------|----------|
| §3 整体结构 | 任务 2 |
| §4 Hero | 任务 2 步骤 1 |
| §5 7 条交替 | 任务 2 步骤 2 |
| §6 此外还支持 | 任务 2 步骤 2 |
| §7 图片重命名 | 任务 1 |
| §8 未引用截图保留 | 任务 1 不碰其余 7 文件 |
| §9 验证 | 任务 3 |

## 禁止项（本计划不含）

- 不压缩/裁剪图片
- 不修改架构、快速开始、内置扩展等章节
- 不引用 §8 列出的 7 张备用截图
