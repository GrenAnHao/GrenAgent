# RepoWiki 宿主项目后端对齐报告

日期：2026-10-31。范围为宿主项目投影、窗口上下文、子进程生命周期与嵌入态监听。未提交、推送或调用付费模型。

## 落地接口

- `WorkspaceService.subscribeProjectsChanged(handler): () => void`：只在 `opened-projects.json` 真正写入成功后通知；重复登记不通知。remember / forget / listProjects 清理失效目录共用串行队列，避免并发切项目丢登记。
- `WorkspaceService.isConversationWorkspace(workspace): Promise<boolean>`：只按真实 `worksDir` 路径分类 scratch，不登记或批准项目。
- `RepoWikiService.onHostProjectsChanged(): Promise<void>`：去重 roots 变更通知，对可信已登记 sender 发 `repoWiki://workspaces`。
- `resolveModel(workspace?: string)`：仅把已登记且 canonical 精确匹配的当前 workspace 传给宿主模型绑定。
- `repoWiki_activate({ workspace: string | null, project_id?: string, retry?: true })` → `{ workspace, project_id, status: 'ready' | 'loading' | 'empty', context_id }`。可选 project_id 只能选择当前已授权 workspace 的既有语言 namespace；retry 只在 supervisor 失败后由显式用户操作重建。
- 后续 `repoWiki_*` 请求必须带 `__repoWikiContext`；宿主剥除后仍由原 vendor schema 和项目路径授权校验。旧 token 返回 409，非当前项目返回 403。健康和集合查询可在空上下文使用。

## 行为与边界

`repoWiki_projects` 从宿主登记根自动补齐 Wiki 元数据。先以 canonical path + language 匹配持久化记录，缺失才 create；同步与同语言 create 合并并发。Windows 大小写、realpath、重复根不重复建项目，已撤销的项目不再投影。真实重入测试把既有项目的 wiki_plan.json 损坏，再确认重入仍成功；上游 create 在去重前会校验此文件，因此此断言能发现重复 create/scan。

未登记但正在切换的 workspace 返回 loading，不自行批准。真实 createConversation() 返回的非空 cwd 经宿主分类返回 empty；null 也返回 empty。scratch 激活不启动 child，也不产生重试通知。

workspace 或明确语言 namespace 切换先换 context，立即摘除旧 supervisor，再等待其停止。新语言 create 成功也换 token、取消旧 namespace 的运行并发通知；界面随后重新 activate 获取权威 project_id。单纯同 workspace / namespace 重入复用 token。A→B→A 产生新 token。

自动崩溃恢复、模型配置或授权根引起的 supervisor 替换会由宿主换 token，并在新 child ready 后通知重新激活。进度事件同时绑定 context、supervisor、物理 PID 和 instance，避免 vendor 异步授权后晚到的旧事件回流。底层 ProcessClient 入口另以 `this.child === child` 拦截旧物理 child 的任何消息；不以 accepting 拦截，保留关闭握手响应。

重启预算耗尽后保留 failed supervisor，普通激活和轮询不能无限重建。显式 `retry: true` 才创建新 supervisor。首次启动失败也保留失败状态，等待显式重试。

宿主固定传 `REPOWIKI_EMBEDDED=1`。child 在 providerFactory 拒绝 demo，并给 service 传 `automaticGeneration: false`；持久化的旧 demo watch 继续扫描并标 `needs_generation`，不自动改文档。独立模式默认自动行为保持不变。空授权根不会启动上游 unrestricted child；缺模型仍可读。

## 验证

- `npx vitest run electron/app/repoWikiHostProjects.integration.test.ts electron/app/repoWikiService.test.ts electron/app/workspaceService.test.ts --project main --testTimeout 60000`：66/66 通过，0 跳过；104.72 秒。包含 7 条真实 WorkspaceService + bundled Electron child 集成：项目/并发/去重与免重复扫描、延迟登记/撤销、真实 scratch、真实 kill 恢复、新旧 token/instance、真实语言 namespace 来回与集合重入、持久化旧 demo watch 保护、耗尽预算后显式 retry。
- `node --import tsx --test vendor/repo-wiki/packages/process/tests/client.test.ts`：10/10 通过，0 跳过。
- `node --import tsx --test --test-name-pattern=watcher vendor/repo-wiki/packages/service/tests/service.test.ts vendor/repo-wiki/packages/service/tests/cards.test.ts`：4/4 通过，0 跳过；证明独立模式兼容。
- `npx tsc -p ../.tmp-repowiki-source/repoWikiService.tsconfig.json`：通过。该配置仅检查本次宿主边界与 child 的依赖闭包。
- `npm run verify-notes`：通过；132 条笔记、1 条档案，6 条既有证据警告。

先观察到的失败包括：activate 不存在；真实 scratch 原返回 loading；真实 child kill 后无新 context 通知；旧物理 child.emit 的 progress 穿透；旧 demo watch 自动刷新后返回 watching 而非 needs_generation；显式 retry 原被 schema 拒绝。修复后均保留对应回归。

沙箱内 Node fs.realpath 对新建临时目录返回 EPERM，pnpm 也无法 canonicalize 工作区。相关真实文件/child 测试和笔记校验经工具审批在沙箱外运行；仅用临时数据。早期多次 child 重入测试超过默认 5 秒或 30 秒窗口，已给这些真实进程流程明确 60 秒超时；断言保持不变。

完整 `tsconfig.repo-wiki.json` 曾在并行开发时报告 AgentData threadStore 的 SQLite casts、ingest TraceFn 参数与 codeGraph SegmentMatch 既有/在途错误；本次文件的窄闭包无错误。总体验证与最终笔记迁移由父线程汇总。

## 修改文件

- electron-agent/electron/app/repoWikiService.ts
- electron-agent/electron/app/repoWikiService.test.ts
- electron-agent/electron/app/repoWikiHostProjects.integration.test.ts
- electron-agent/electron/app/workspaceService.ts
- electron-agent/electron/app/workspaceService.test.ts
- electron-agent/vendor/repo-wiki/packages/process/src/client.ts
- electron-agent/vendor/repo-wiki/packages/process/src/child.ts
- electron-agent/vendor/repo-wiki/packages/process/tests/client.test.ts
- electron-agent/vendor/repo-wiki/packages/service/src/service.ts

未修改 main、AgentData 调度、UI 或其他代理拥有的文件。
