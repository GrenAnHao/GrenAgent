# GrenAgent README 预览图排版设计

> 状态：已实现。计划：`docs/superpowers/plans/2026-06-20-readme-preview.md`

## 1. 背景与目标

根目录 `README.md` 目前为纯文字，缺少产品视觉预览。`images/` 目录已有 15 张 GrenAgent 桌面端截图（统一 1035×654），需融入 README 作为成品预览。

**目标**：

- 访客在 GitHub 首屏即可感知产品形态与核心能力。
- 排版清晰、维护成本低（语义化文件名 + HTML table 交替，无外部依赖）。
- 不改动 README 除「特性」外的既有章节结构。

**非目标**：

- 不制作 GIF / 视频。
- 不在本次引用全部 15 张图（未用截图保留在 `images/` 备用）。
- 不压缩或裁剪源图（GitHub 按容器宽度缩放即可）。

## 2. 用户决策摘要

| 编号 | 问题 | 选择 |
|------|------|------|
| Q1 | 整体排版 | **B · 特性图文交替** — 每条功能 bullet 配一张截图，左右交替 |
| Q2 | 无专属截图的功能（知识库、长期记忆、用量统计、终端 Dock、IM） | **仅展示有截图的条目** — 无图功能以紧凑文字段补充 |
| Q3 | Hero 图 | **代码图谱全景**（227 文件 · 674 依赖可视化） |

## 3. README 整体结构

```
# GrenAgent
[简介段落 — 保持现有 1 段，不改措辞]

[Hero — 全宽代码图谱]

## 特性
[7 条 · HTML table 图文交替]

[「此外还支持」— 5 条纯文字 bullet]

## 架构
[现有内容不变]
…后续章节不变…
```

Hero 与 `## 特性` 之间不加额外小标题。7 条交替区与 5 条纯文字段之间用空行分隔，避免有图/无图混在同一 table 序列中。

## 4. Hero 区

| 项 | 值 |
|---|---|
| 源文件 | `images/8bf01f949a834c9348c89183db68531fafc5fd16_2_1035x654.jpg` |
| 重命名后 | `images/hero-code-graph.jpg` |
| 位置 | 简介段落后、`## 特性` 之前 |
| Markdown | 见 §6.1 |
| Alt 文本 | `代码图谱 · 227 个文件 · 674 条依赖` |

Hero 展示 CodeGraph 依赖全景；第 3 条交替行用索引统计面板，与 Hero 形成「可视化 + 量化指标」互补。

## 5. 特性区 — 7 条图文交替

GitHub Markdown 不支持 float 布局，使用 `<table>` 实现左右交替。奇数行（1、3、5、7）文字在左、图在右；偶数行（2、4、6）图在左、文字在右。

| # | 标题 | 文案来源 | 截图（重命名后） | 图侧 |
|---|------|----------|------------------|------|
| 1 | 多会话与项目管理 | 现有特性 bullet 原文 | `workspace-context.png` | 右 |
| 2 | 流式对话 | 现有特性 bullet 原文 | `chat-diagram.png` | 左 |
| 3 | 代码智能 | 现有特性 bullet 原文 | `code-index.png` | 右 |
| 4 | Git 集成 | 新撰一句（见 §5.1） | `git-graph.png` | 左 |
| 5 | 多供应商 | 现有特性 bullet 原文 | `providers.png` | 右 |
| 6 | MCP 扩展 | 新撰一句（见 §5.1） | `mcp-servers.png` | 左 |
| 7 | Skills 工作流 | 新撰一句（见 §5.1） | `skills.png` | 右 |

### 5.1 新增条目文案（不在原 9 条特性列表内，但有强截图）

- **Git 集成** — 改动 diff、分支切换、提交图谱，与 workspace 上下文一体。
- **MCP 扩展** — 连接外部 MCP server，工具以 `mcp__<server>__<tool>` 暴露给 Agent，面板内测试连接与权限配置。
- **Skills 工作流** — 从 `~/.agents/skills` 加载技能，`/skill:name` 调用，面板内启用/禁用。

### 5.2 Table 模板

**奇数行（文字左 · 图右）**：

```html
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
```

**偶数行（图左 · 文字右）**：

```html
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
```

每条 table 后插入 `<p></p>` 作为行间距（GitHub 对连续 table 间距较紧）。

## 6. 无截图功能 — 紧凑文字段

置于 7 条交替 table 之后、`## 架构` 之前：

```markdown
此外还支持：

- **知识库 RAG** — 文件分块后做向量或关键词检索，面板内用原生文件选择器添加文档。
- **长期记忆** — 跨会话的记忆抽取与检索。
- **用量统计** — 按天、模型、项目聚合 Token 与费用。
- **终端 Dock** — 终端 tab 容器，子代理会话独立成 tab。
- **IM 接入** — 微信（ilink 官方 bot）扫码登录，手机遥控 Agent；「连接」面板展示登录状态与会话只读镜像。
```

文案与现有 `## 特性` bullet 保持一致（从原 9 条迁移，不在交替区重复出现）。

## 7. 图片文件整理

实现时先将 hash 文件名重命名为语义化名称，再更新 README 引用。仅引用下列 8 张；其余 7 张保留在 `images/` 不删除。

| 新文件名 | 源文件 |
|----------|--------|
| `hero-code-graph.jpg` | `8bf01f949a834c9348c89183db68531fafc5fd16_2_1035x654.jpg` |
| `workspace-context.png` | `d10b2fca34f498411fbc2097e37d34c87e3e024f_2_1035x655.png` |
| `chat-diagram.png` | `711cd34dcbd81d8f3015cf8f2a3f21c4def3080c_2_1035x655.png` |
| `code-index.png` | `3564a6d45c2740b2d6056a638a64e5e2821387f8_2_1035x654.png` |
| `git-graph.png` | `102623f858b57166cc46de4416fdc5d8b4eadae0_2_1035x654.png` |
| `providers.png` | `beacaae2d4fdc62c46c835222a46704476b9f12c_2_1035x654.png` |
| `mcp-servers.png` | `0cee30d965af04ae10d79a3c32fce838fc6f1155_2_1035x654.png` |
| `skills.png` | `906d682e782216582d362c0b9956d4e0e26b2220_2_1035x654.png` |

### 6.1 Hero Markdown 片段

```markdown
<p align="center">
  <img src="images/hero-code-graph.jpg" alt="代码图谱 · 227 个文件 · 674 条依赖" width="100%">
</p>
```

## 8. 未引用截图（保留备用）

以下文件本次不引用，不重命名，不删除：

- `22e569bbdad8022d292ff054bc877b8cdadf0d73_2_1035x654.png` — 改动 diff
- `2b56b794ee4e11dea30c7db869c3c3bf4598b783_2_1035x655.png` — 模型选择器
- `41accbc57912021c460286c9665c8d0e3bda5c41_2_1035x655.png` — 富对话（公式）
- `788859c600aa102a4e28e53576bcbfe2ccbe21a8_2_1035x654.png` — 审批策略下拉
- `8e0d3e8121a470f3aff88652f3c27a6677a8620b_2_1035x654.png` — 代码智能设置
- `97e7121fba1d55e6f8e1c16a6971eb6d7800dac1_2_1035x655.png` — Agent 模式选择
- `f3e9735c472919558294162d8e53bf2b58af29b2_2_1035x654.png` — Git 分支菜单

## 9. 实现范围与验证

**修改文件**：

- `README.md` — 插入 Hero、重写 `## 特性` 为 7 条 table +「此外还支持」段；删除原 9 条纯 bullet 列表（内容已迁移）。
- `images/` — 重命名 8 个文件（git mv 或 copy + 删旧名，保留 git 历史优先用 `git mv`）。

**验证**：

- 本地 Markdown 预览或 GitHub 渲染：Hero 全宽、table 左右交替正确、图片路径有效。
- 确认原 `## 特性` 9 条能力在 7 条交替 + 5 条「此外还支持」中无遗漏、无重复矛盾。

**不在范围**：架构、快速开始、内置扩展、文档、目录结构、许可证等章节。

## 10. 规格自检

| 检查项 | 结果 |
|--------|------|
| 占位符 / TODO | 无 |
| 内部一致性 | Hero（图谱）+ 第 3 条（索引）分工明确；9 条原特性均已覆盖 |
| 范围 | 单次实现计划可完成（重命名 8 文件 + 改 README） |
| 模糊性 | 交替方向、文件名、条目顺序均已固定 |
