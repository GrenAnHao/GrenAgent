# Repo Wiki 宿主项目自动跟随 UI 修复

日期：2026-10-31。代码保持当前工作区，未提交、未推送、未调用付费模型。

## 交付

- `src/features/repoWiki/RepoWikiWorkspace.tsx`：观察唯一宿主 `activeWorkspace`，调用 `repoWiki_activate({workspace})`。主进程回 `loading` 时保留等待状态，订阅 `repoWiki://workspaces` 后重试，并以 750ms 定时重试补齐先切 workspace、后登记项目的窗口。卸载释放定时器和晚到订阅。
- host adapter 在 vendor `validateRequest` 之后的 runtime invoke 外层附加 `__repoWikiContext`。每个请求开始/完成都检查当前 workspace 和 token；事件检查宿主 `context_id`，拒绝旧上下文回流。
- `RepoWikiPanel` / `App` 新增显式 `hostContext` 与 `onSelectWorkspace`。准备完成自动选择主进程返回的 project_id 并进入原有概览。切换开始即隔离旧项目、页面、来源、弹层、进度与变更。
- 集合列出宿主 registry 自动导入的项目。选另一项目走既有 `pi.openWorkspace()` + `applyOpenedProject()`，同步全局 workspace/session/draft；没有第二套独立项目选择。
- 嵌入宿主模式隐藏连接/克隆仓库入口、独立 provider 模式选择，显示“使用系统知识调度”。无宿主项目显示“还没有打开的项目”，引导侧栏打开项目。保留森林绿、首页插画、搜索/过滤、知识概览、阅读/源码/卡片、计划和语言功能。
- App 按 project 缓存未保存页面、原 revision 和编辑正文。A→B→A 以及同 workspace 登记短暂不可用均恢复草稿。模块离开/窗口关闭保护也检查缓存中的其他项目草稿。保存成功/明确放弃才删除缓存。
- 进度检查 project、child instance、sequence 和退役 run ID；generate 返回的 run_id 建立当前运行身份。已在途旧 poll 不得覆盖后到进度事件。

## 测试夹具修正

`testing/runtimeFixture.ts` 从 openedRoots（Forest + 无会话 Next）开始，Wiki registry 初始为空；activate/projects 自动同步登记。probe 不再手动 create。仅主进程 I/O 是确定性桩，实际 ModuleRail → ModuleContainer → RepoWikiWorkspace → vendor Panel/App 与 renderer client 保持真实。真实主进程/OS child/provider/统一知识调度链路由父任务独立验证，本 UI 结果不冒充付费 provider 实测。

## 红灯证据

实现前定向测试原版无法自动进入“Repo Wiki 概览”，仍停在带“连接仓库”的项目集合。补充回归分别复现：在 B 离开模块会丢 A 的缓存草稿、旧 run poll 覆盖最新进度、generate 返回后旧 run 的高序列事件倒灌、同 workspace 登记恢复后编辑器丢失。相应修复后下面命令全部通过。

## 最终验证

工作目录 `electron-agent`；TEMP/TMP 显式设为 `C:\Users\rxstudio\AppData\Local\Temp`（默认 sandbox 临时目录的 vitest cache rename 曾报 EPERM，改用已授权 Temp 后通过，无权限绕过）。

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/features/repoWiki/RepoWikiWorkspace.test.tsx src/features/repoWiki/repoWikiClient.test.ts` | 2 文件、21 测试通过，exit 0（17:28:02 开始） |
| `npm run test:repo-wiki-ui` | 9 文件、71 测试通过，exit 0（17:26:54 开始） |
| `npm run typecheck:repo-wiki` | exit 0 |
| `npm run ui:check -- repo-wiki` | 生产构建；离屏 Electron；69 PASS / 0 FAIL；exit 0（17:27:03 场景开始） |

UI 只跑了 1/44 个场景，其余 43 个未指定、未运行；没有跑全量。Electron 会输出资源包 `chrome_100_percent.pak` 缺失警告，但加载真实页面、全部断言及截图均成功。

真实 UI 断言覆盖：宿主项目自动导入与概览、0 create/0 自动 generate、集合搜索/插画/森林绿/路由保持、选择 Next 同步宿主、源码/Markdown 阅读、A-B-A 隔离和草稿恢复、模块离开保护、失败保存保留/成功修订保存、卡片分离、生成前本次源码授权、取消当前项目、失败与重试、关闭/重挂订阅及 poll 清理。

## 截图

- `ui-evidence/collection.png`：宿主 Forest/Next 自动出现在原森林绿首页，保留插画和搜索。
- `ui-evidence/overview.png`：当前项目自动概览，顶部显示“使用系统知识调度”。
- `ui-evidence/card-reader.png`：原知识卡片阅读页。
- `ui-evidence/scratch-empty.png`：非空普通对话临时工作区的宿主项目空态，保留原插画且无连接入口。

已目视检查 collection/overview/scratch-empty：布局正常，无新增连接/provider 设置；原浅色森林绿视觉保留。

## 范围与剩余

未编辑 main、后端、调度、配置或其他 UI 场景。项目登记同步、上下文授权/取消、实际模型选择/统一知识调度由对应后端任务拥有。未在本子任务运行 verify-notes，由父任务在合并本批证据、迁移总笔记后统一运行。当前 UI 验证无阻塞。

## 审查追加边界（已实现并重新验证）

1. **合法 child 重启的握手**：仍固定当前 token 内的首个 instance，拒绝任意新 instance。后端生命周期轮换 context_id 并发 `workspaces`；UI 不按旧 token 过滤该通知，而是立即作废旧 token、隔离旧视图并重新 activate。新 token 获得后才建新 client/cursor。回归先复现握手未完成时旧进程延迟事件仍显示的红灯，再修复；真实场景检查恢复后的新进度有效、旧事件无效。
2. **快速重启不丢编辑**：显式 contextId 传到 App 并参与同步 scope/layout。即使 React 自动批处理跳过 loading 中间帧，也先缓存旧编辑器再让新 client/request 重置页面。回归先复现立即完成 restart 后编辑器丢失的红灯，修复后保存请求使用新 token 和原 revision；真实场景在有 dirty draft 时重启，然后走失败保存与成功保存，确认仍可继续编辑/保存。
3. **语言 namespace 一份权威**：集合按宿主当前 project_id 优先分组展示；同目录另一个 namespace 必须调用可信 `activate({workspace,project_id})`，不再因 same path 早退。create 语言切换轮换 token 且先发通知的夹具模拟真实后端；UI 丢弃旧 create response，由新的权威 activation 进入正确语言。英文→集合→重新进入保留英文，显式选择同目录中文可通过 host activate 切回，无 403。先复现原回集合无法再进入的红灯。
4. **非空 scratch 空态**：fixture 使用真实非空 works/conversation-draft cwd，模拟主进程可信分类 empty；组件与 Electron 都等待超过 750ms，确认没有永久 loading 或重复 activate。
5. **预算耗尽显式恢复**：activation 错误显示原因与“重试”按钮，只有点击发送 `retry:true`。测试与真实场景等待超过重试周期，确认普通错误不自动反复重建；显式恢复后重新显示项目。先复现缺少重试按钮的红灯。

最终 UI 范围：19 个真实组件测试 + 2 个 client 测试，9 个 vendor 文件的 71 个回归，repo-wiki 场景 69 个断言。所有命令最后一次 exit 0。
