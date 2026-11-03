# Agent Note: Repo Wiki 宿主界面只用知识内核投影，按 Qoder 两态布局重做

Status: implemented

## Problem

KnowledgeKernel 接入后，宿主模式下阅读页同时跑两套状态：旧 `run` 进度（轮询 `repoWiki_run`、`.generation-banner`、失败/取消横幅、旧版概览）和新知识快照。快照没到之前先画旧界面，之后换成一套没有样式的新卡片；同一屏会出现「生成文档」主按钮和「修复失败项」挤在一个绿色分割按钮里、原始错误码 `GIT_PROBE_FAILED`、「2 / 待计划」与「发布成果」并存这类自相矛盾的状态。新加的 antd 控件又被 vendor 的全局 `button { border:0; background:none }` 重置剥掉样式，暗色宿主主题下还会把暗色 token 画在浅色面板上。

## Decision

- 宿主模式（有 `hostContext`）下知识快照是唯一运行权威：不再读 `repoWiki_run`，旧进度横幅、失败/取消横幅、旧版概览只留给独立 vendor 应用。快照未到时概览显示「正在读取生成状态…」，生成入口不可用（内核要冻结的模型身份和计划 token）。
- 概览按 Qoder 知识中心的两态组织（参考 `E:\Qoder\resources\extensions\qoder.knowledge.center\dist\browser\view.cjs` 的 `RepoWikiStatusCard` / `RepoWikiOverviewActions` / `RepoWikiRunProgress`，只参考结构和文案，不搬代码）：
  - 结算态：状态卡（语言切换、生成状态、文件数、更新时间、已更新至）+ 一行提示 + 一个主按钮（生成 / 更新 / 重试）与相连的「更多」菜单。
  - 运行态：阶段标题 + 描述 + 进度条（总数冻结前不画）+ 只读语言/当前内容 + 「暂停/继续/重新分析」与「取消」两个按钮。
- `knowledgeProjection.ts` 负责把快照翻译成上述文案和唯一主动作：阶段标题按域映射；失败且有可复用成果时主动作是 repair，否则就是重新生成；内核错误码翻译成中文说明；发布被 pin 时不给任何动作。
- 控件统一用 antd（Button / Dropdown / Segmented / Progress / Divider / Typography / Flex），阅读页横幅与概览共用 `KnowledgeRunProgress` / `KnowledgeActions`。`RepoWikiWorkspace` 用 `inherit: false` 的浅色 ConfigProvider 包住面板，主色与面板森林绿一致；vendor 重置样式跳过 `.ant-*`。
- 项目集合首页实时显示任务：AgentData 任务列表（`TaskView.knowledge`）经 `RepoWikiWorkspace` 按工作区路径汇总成 `KnowledgeActivity`，当前打开项目再用自己更新的快照覆盖；运行中、暂停、需要处理、失败的卡片显示「生成中 75%」这类状态、当前阶段与底部进度条，完成或取消后回到保存的状态。任务监视器在 Repo Wiki 视图下也按活动任务轮询，不再只轮询本页创建的任务。
- 测试桩照生产行为：`repoWiki_knowledge` 永远回快照（由桩里的 run 记录投影），`repoWiki_action` 没有预设响应时按动作改写 run。

## Alternatives considered

- 在 App.tsx 里直接删掉旧 run 代码：最干净；暂不采用，独立 vendor 应用与其 71 项回归仍使用旧事件流，删除要同时改写上游界面。
- 保留阶段条（Steps）展示全部阶段：信息最全；不采用，Qoder 只给当前阶段标题与描述，七个圆点在 440px 卡片里挤且与主进度重复。
- 不加嵌套 ConfigProvider，改为让整个面板跟随宿主暗色：长期更统一；本次不做，vendor 样式里有大量写死的浅色值，部分变暗反而更割裂。

## 验证

- `pnpm exec vitest run src/features/repoWiki`：4 文件 53 项通过。
- `pnpm exec vitest run --config vitest.repo-wiki.config.ts`：9 文件 71 项通过（独立应用旧路径未受影响）。
- `pnpm run test:repo-wiki`：238 项通过；`pnpm exec vitest run electron/knowledgeProcess electron/agentData/knowledgeKernel`：21 文件 121 项通过。
- `pnpm exec tsc -p tsconfig.repo-wiki.json`：通过。
- `node ui-harness/check.mjs repo-wiki`：150 passed, 0 failed（含项目集合卡片实时状态）。截图与日志在 `.agents/evidence/2026-11-01-repo-wiki-unified-knowledge-ui/`。
- 未用真实模型跑完整生成。

## Consequences

任务状态相关展示只能走 `projectKnowledge()` 与 `KnowledgeRunStatus.tsx` 里的组件，不要在 App.tsx 再判断 run 状态或写标签。面板内新增 antd 控件会自动拿到浅色主题；若要让面板跟随宿主暗色，先清理 vendor 里写死的颜色，再去掉 `RepoWikiWorkspace` 的 `inherit: false`。
