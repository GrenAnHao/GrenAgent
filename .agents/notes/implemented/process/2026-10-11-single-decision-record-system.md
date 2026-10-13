# Agent Note: 决策记录只用 .agents/notes，docs/decisions 冻结

Status: implemented

## Problem

仓库里同时有两套决策记录：`docs/decisions/`（约 170 篇，格式 背景 / 决定 / 放弃的方案 / 后果，`scripts/check-notes.mjs` + pre-commit 钩子校验）和 2026-10-09 起的 `.agents/notes/`（write-notes-like-deepseek）。已有 6 篇同主题双写，新决定不知道该写哪边，检索要翻两处。

## Decision

用户 2026-10-11 决定：

- `.agents/notes/` 是唯一有效的决策记录；新决定只写这里，按 `.agents/skills/write-notes-like-deepseek/SKILL.md` 的格式与生命周期（proposed / implemented / rejected / archived）。
- `docs/decisions/` 冻结为只读历史：仍有效的约 50 篇决定已合并迁入 `.agents/notes/implemented/`，源文件顶部加「已迁移」墓碑；其余（界面细节、一次性修复、已被取代的）原地冻结，不再新增或修改。`docs/decisions/_template.md` 作废，模板见 `.agents/skills/write-notes-like-deepseek/templates/`。
- `docs/architecture.md` 仍只写系统现状事实。
- 校验统一为根目录 `pnpm run verify-notes`；pre-commit 钩子改为跑它，不再跑 `scripts/check-notes.mjs`。

### 涉及文件

- `AGENTS.md`
- `docs/decisions/README.md`
- `.git/hooks/pre-commit`
- `scripts/check-notes.mjs`

## Alternatives considered

- **两套并存，各管一摊（例如 docs/decisions 管历史、.agents/notes 管新）**：迁移成本为零。不选：边界说不清，新决定仍会两边写；重复的 6 篇已经说明会发生。
- **把 .agents/notes 并回 docs/decisions**：docs/decisions 积累多、已有钩子。不选：用户选择 write-notes-like-deepseek 的生命周期与校验（proposed / implemented 门禁、证据闭环），docs/decisions 的「正文永不修改」与「笔记是当前法律、原地更新」相冲突。
- **全部 170 篇逐篇迁移**：最完整。不选：大部分是界面细节和一次性修复，不约束未来改动；迁过来只会稀释检索。

## Consequences

- 查旧决定：先查 `.agents/notes/`；需要考古时再 grep `docs/decisions/`（只读）。
- `scripts/check-notes.mjs` 不再挂钩子；它仍可手动运行检查冻结目录。
- 代码注释里仍有指向 `docs/decisions/...` 的路径（如 `electron-agent/electron/agentProcess/hostEntry.ts`、`electron-agent/scripts/agent-host-smoke.mjs`），这些文件有墓碑可跳转；按「不碰业务代码」本次不改。

## Verification

- 迁移后 `pnpm run verify-notes`：通过（2026-10-11，Grok Bot 执行）。
