# Repo Wiki UI 链接适配交付

## 结果

Markdown 阅读链接现在保留正式导航的原有 `navigate(id, mode)` 合同：正文回调只传页面 ID 给 `navigate`，hash 由 App 单独保存。正式页面在目标页面数据加载并挂载后定位；同页重复 hash 也会重新定位，不改宿主 `location.hash`。未发布草稿使用阶段前缀 ID 选择草稿、使用去前缀的 logical page ID 解析相对链接，只匹配当前草稿集合，不会误跳到同 ID 的正式页。

测试夹具覆盖概览到嵌套页、`./sibling.md`、`../guide%2Dname.md?view=reader#detail`、来源引用、代码示例和草稿对应流程。Wiki slug 继续遵守 contracts 中既有 ASCII `[A-Za-z0-9_-]` 路径段约束；因此本次集成用合法 `guide-name`，不宣称 Wiki slug 支持空格或 Unicode。源码引用对空格路径的编码回归仍保留在 Markdown 单测中。

## 验收证据

- `ui-links-app-final.log`：真实 Electron 生产构建 `repo-wiki` 场景，184 项通过、0 失败；仅运行此场景。
- `ui-links-final.diff`：相对 `ui-preimage/` 的六个授权文件完整限定差异。
- `repo-wiki-links-formal-cross-page.png`：真实点击编码嵌套 Wiki 链接并到达 `Detail` 后的画面；已人工检查。
- 当前直接检查：`npx vitest run --config vitest.repo-wiki.config.ts vendor/repo-wiki/apps/web/src/workspace/Markdown.test.tsx`（16/16）与 `npm run typecheck:repo-wiki` 均通过。

此前 App 集成 RED 曾暴露回调作用域错误及夹具用非法 slug；已修正并在上述完整 Electron 运行中覆盖。手头的 `ui-links-red.log` 及 `ui-links-green.log` 仍分别记录 Markdown 解析器修复的 RED 4 项 / GREEN 16 项。
