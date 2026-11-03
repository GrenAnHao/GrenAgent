# Repo Wiki v3 接入验收

本目录保存首阶段记录。当前入口及最终验收见 [项目文件与按需服务](../2026-10-31-repo-wiki-project-files-and-lazy-service/README.md)，中间阶段调度接线见 [宿主工作流接入](../2026-10-31-repo-wiki-host-workflow-alignment/README.md)。以下手工连接流程和模型桩结果仅代表首阶段，不作为当前系统流程集成的证据。

源码来自用户指定的本机 ZIP；SHA256 与确认的 v3 完全一致，见 [results.json](results.json)。代码保留在 `electron-agent/vendor/repo-wiki`，沿用已认可的浅色森林绿界面，没有启动 standalone HTTP/demo 路径。

## 入口与修改

左侧 **Repo Wiki** → **连接仓库** → 使用当前工作区 → Wiki / 知识卡片概览 → 阅读。只能使用宿主已登记的工作区；主进程独立核验窗口、frame 与目录权限。新构建运行后入口生效。

| 范围 | 主要文件 |
| --- | --- |
| 真实面板与导航 | `src/features/repoWiki/RepoWikiWorkspace.tsx`、`src/stores/moduleStore.ts`、`src/features/layout/ModuleRail.tsx`、`src/features/workspace/ModuleContainer.tsx` |
| 独立服务、真实模型 broker、IPC 与退出 | `electron/app/repoWikiService.ts`、`electron/main.ts`、`electron/ipc/register.ts`、`electron/agent/workerEntry.ts` |
| 构建和打包 | `electron/agent/repoWikiHostBuild.ts`、`electron.vite.config.ts`、`electron-builder.yml`、`tsconfig.repo-wiki.json`、`package.json`、`pnpm-lock.yaml` |
| 回归入口 | `scripts/test-repo-wiki.mjs`、`vitest.repo-wiki.config.ts`、相关宿主测试、`ui-harness/scenarios/repo-wiki.tsx` / `probes/repo-wiki.mjs` |
| 上游适配 | vendor 面板宿主 props、草稿导航保护、renderer 类型接缝、Windows Git 空设备、HTTP 413 和离线 WAL 测试夹具；许可与来源保留 |
| 许可与决策 | 许可证实际依赖图收集、第三方清单、AGENTS 场景登记、三篇 implemented 决策笔记 |

表中未写前缀的工程路径均在 `electron-agent/` 下。原有无关未提交改动保留，没有提交、推送或发布。

## 验证结果

- `npm run build` 与 `npm run typecheck:repo-wiki` 通过。生产 child 是 173,523 字节的单文件 CJS，仅外置 Node 内建模块。
- `npm run test:repo-wiki`：194/194 通过，零失败、取消或跳过；临时构建并使用实际 Electron 子进程，覆盖持久化、Wiki/cards 隔离、人工编辑冲突、取消/重试及崩溃恢复。
- `npm run test:repo-wiki-ui`：原版面板 9 文件、71/71 通过；示例 3/3 通过。
- 宿主后端 52/52、前端 33/33、构建与许可证 21/21 通过。
- `npm run ui:check -- repo-wiki`：真实静默 Electron 37/37 通过；只跑 1/44 场景。截图已检查，见 `frontend-shots/`。
- 真实 BrowserWindow + 正式 preload + 正式 IPC 分发 smoke 通过：主 PID 24960、child PID 85456；同地址其他窗口、页面导航后的访问均拒绝，停止后 child 清理完成。
- 实际生产 child 复制到 `resources/app.asar.unpacked/out/main/repo-wiki-host.cjs` 形式路径后运行通过：父 PID 30600、child PID 56796，创建/读取与退出通过。没有生成安装包。
- 独立静态与定向复审未发现重要缺陷。修复前失败和最终成功均记录在本机工作日志；目录中的日志保存最终证据。
- 根目录 `npm run verify-notes` 通过：131 篇笔记及相对链接、格式、归档封印和证据门禁通过，仅保留 6 条旧笔记结果措辞警告。

## 已知验证边界

模型 broker 使用确定性桩验证，没有发起付费供应商请求。旧工程整体 node / harness 壳类型检查仍有既有错误，本次新生产代码的实际 strict 工程通过。初次普通沙箱 GUI/缓存权限失败经正常授权重跑后通过，不能据此认定当前 Electron 无法运行。当前安装 Electron 仍输出已有 pak 资源提示，但真实页面和 IPC 检查已完成。

维护用全套 runner 正常退出会清理临时产物；单独强制终止其父进程时的测试进程树清理尚未另作故障注入验证。生产应用退出与子进程清理已有真实测试。
