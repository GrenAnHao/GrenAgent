# UI 链接修复交接：切换执行者

状态：按用户要求完成当前原子操作后停止新增实现；接手者继续实现，Sol 后续只审查。不回滚当前工作。

## 已改文件与归属基线

仅改以下两个产品/测试文件：

- `electron-agent/vendor/repo-wiki/apps/web/src/workspace/Markdown.tsx`
- `electron-agent/vendor/repo-wiki/apps/web/src/workspace/Markdown.test.tsx`

本轮改前副本在本目录 `ui-preimage/`，保留完整仓库相对路径。已保存六个可能涉及文件：上述两个、`electron-agent/vendor/repo-wiki/apps/web/src/App.tsx`、`electron-agent/src/features/repoWiki/testing/runtimeFixture.ts`、`electron-agent/ui-harness/scenarios/repo-wiki.tsx`、`electron-agent/ui-harness/probes/repo-wiki.mjs`。后四个尚未改。限定当前差异：`ui-links-partial.diff`。vendor 多数原本 untracked，不能用普通 Git diff 代替本轮基线。

## 已实现及证据

- Markdown 增加可选 `currentPageId`；缺参仍按根级解析，保留旧调用条件。
- Markdown 复用 core 新建的 `shared/wikiLinks.ts` 分类/归一化，不再独立正则裁剪页面路径。页面回调扩为 `onPage(id, hash?)`；没有 hash 时仍只传一个实参。
- 来源仍发 `onSource({path,start_line,end_line})`，省略行号时沿用 1/80；页内锚点、允许的外链和代码示例保留。
- 导出 `scrollToMarkdownHeading(root,target)`，从原页内锚点逻辑抽出，安全按 heading id 或 slug 匹配、滚动并聚焦；拟供 App 跨页加载后的 hash 定位复用。
- 先增加五项行为测试，`ui-links-red.log` 有 4 项按预期失败（嵌套、编码/query/hash、换页上下文、无效路径）；来源/代码例子回归先通过。
- 修改后 `ui-links-green.log`：Markdown 文件 **16 项全部通过**，2.37 秒。执行命令（工作目录 electron-agent）：`npx vitest run --config vitest.repo-wiki.config.ts vendor/repo-wiki/apps/web/src/workspace/Markdown.test.tsx`。

## 共享接口依赖（已与 core owner 确认）

所有者 `/root/repair_generation_boundary`；路径 `electron-agent/shared/wikiLinks.ts`，由 core 写，UI 不要改 shared。

`resolveWikiLink(href: string, currentPageId?: string)` 返回：

- `{kind:'page',pageId,path,hash?}`：path 是解码后的原相对路径，pageId 按当前页面目录归一化并去 `.md`；query 不进入 ID；hash 无 `#`、已解码。
- `{kind:'source',path,start?,end?}`：source 显式协议或相对 `#Lx-Ly`；源码路径是 repo-root 相对，不随 Wiki 页目录移动。
- `{kind:'anchor',hash}`、`{kind:'external',url}`、`{kind:'invalid'}`。
- 外链只允许 http(s)、mailto、`//`；未知协议、绝对本地路径、非法编码、越根路径拒绝。renderer 仍保留 react-markdown 默认 URL transform，仅对 `source:` 使用原有例外。

## 尚未完成，接手顺序

1. **先完成 App 适配，当前尚不能宣称构建通过。** `App.tsx` 约 2057 行仍把 `navigate` 直接作为 `onPage`；它的第二参数是 `'wiki'|'cards'`，而现在 Markdown 第二参数为 hash，必须改为包装回调，不能把 hash 当 contentMode。正式阅读入口传 `currentPageId={page.id}`；未发布草稿入口约 2492 行传 `currentPageId={stagedDraftId}`。Legacy `WikiContent` 无当前页面上下文，保持缺参根级合同。
2. 正式/草稿跨页 hash 要在目标正文加载并挂载后调用 `scrollToMarkdownHeading`。建议 App 用一个待定位状态 `{pageId,hash,draft?}`，正式路由发生其他导航时清掉；仅目标 page.id/selectedId 相符、preview 正文挂载后消费。不要直接查询 host hash、不要改 `navigate(id,targetMode)` 的原入口含义。同页重复点击同一 hash 也应可再次定位。
3. 先给 App 路径或 `repo-wiki` harness 加失败证据，验证从嵌套页真实点击 `./sibling.md`、`../guide%20name.md?view=reader#detail` 正常读取精确页 ID、到达目标标题、宿主 hash 不变；回程点击/来源仍有效。现有 runtimeFixture 无多页注入，可以小幅增加测试设置方法设置 Wiki 页集合（只动测试夹具），scenario 只造确定性数据，不复制业务解析。
4. 只跑直接受影响的 Markdown/navigation/App 测试与真实 Electron `repo-wiki` 场景；尚未运行新 harness、typecheck 或其他测试，不能用当前 16 PASS 替代它们。查看实际跨页定位截图，保存到本目录。不得运行付费模型、重启用户实例、提交或推送。
5. 最终写 `ui-links-report.md`，生成相对 `ui-preimage/` 的完整限定 diff，并交 root 做审查。根任务已有新 note，不另建笔记。

## 运行边界

仓库 `D:/OneDrive/Project Files/Pi`；全树已有大量 dirty，保留。CodeGraph 已优先用于 indexed 代码；vendor 未索引按磁盘读取。此次未改后端/shared、未派代理、未运行模型、未改模型配置、未重启用户实例。
