# Agent Note: 技能网格卡片互相压住，多行 YAML 描述显示成 ">-"

Status: implemented

## Problem

用户在真实机器上（约 40 个技能）切到网格视图，看到两个问题。

1. 每张卡片的开关和路径压到下一张卡片上，第一张卡片看不到开关。根因来自[三页去重](../feature/2026-11-01-extension-pages-cleanup.md)：为了只让目录滚动，网格容器自己成了定高的滚动容器（`flex: 1 1 0px` 加 `overflow-y: auto`）。技能多到要滚动时，Chrome 把网格行高算得比卡片内容矮，内容溢出到下一行。8 个技能不滚动时不出现，所以原来的场景没抓到。
2. `deploy-agent-notes` 的说明显示成 `>-`。`skillService.ts` 逐行读头部，只取 `description:` 后面那一截，YAML 的折叠写法 `>-` / `|` 后面的多行内容全丢了。

## Decision

- 滚动挪到外层：新增 `skill-catalog-scroll` 包住目录，由它负责 `flex: 1 1 0px`、保底 120px 和 `overflow-y: auto`。里面的列表 / 网格回到按内容长高，网格恢复 `overflow: visible`。
- 技能头部先用 `yaml`（主进程已在用）解析，取字符串型的 `name` / `description`，再压成一行。解析失败时退回原来的逐行读法，以前能读出来的手写头部照样能读。

## Related notes

- [技能、命令、规则页去重](../feature/2026-11-01-extension-pages-cleanup.md)：本篇修它引入的网格回归，目录内滚动的决定不变，只换了承担滚动的元素。

## Alternatives considered

- 卡片里的子元素都设 `flex: none`：猜测是列表行的 `flex: 1` 让卡片算矮，改动只有一行。实测 40 个技能时照样溢出，说明原因不在卡片内部，放弃。
- 网格写死 `grid-auto-rows: max-content` 或给卡片定高：能挡住这一种情况。但定高会截断长说明，`max-content` 仍依赖滚动容器里的行高计算，不如把滚动挪出网格干净。
- 自己补全折叠 / 字面块的解析：不加依赖。但 YAML 的缩进、引号、换行规则多，自己写容易漏；仓库主进程已经依赖 `yaml`，直接用。

## Consequences

网格和列表在任意数量的技能下都按内容高，只有外层滚动。技能说明支持合法 YAML 的所有字符串写法；非法头部还按旧逻辑读。卡片 DOM 多了一层，原来的 `skill-catalog` 测试标识和 `data-view` 不变。

## Verification

- 红灯：场景加 `setManySkills`（40 个技能、长说明、Windows 路径），去掉修复跑 `npm run ui:check -- extensions-workbench`，「40 个技能 网格卡片内容都在卡片框里」失败，40 张卡全部溢出；8 个技能那次通过。先试的 `> * { flex: none }` 也是同样失败，已撤掉。
- 绿灯：同一命令 205 项通过、0 失败，40 张卡片无溢出、无重叠，只跑这一个场景。
- `npx vitest run src/features/extensions electron/app/skillService.test.ts`：全部通过，新增折叠、字面、带冒号的引号写法和非法头部回退四种。
- 证据：`.agents/evidence/2026-11-01-skill-grid-and-yaml-description/`（红绿日志与 40 个技能网格截图）。结果：通过。
