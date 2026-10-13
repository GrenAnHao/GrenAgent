> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-11-packaging-constraints.md](../../../.agents/notes/implemented/architecture/2026-09-11-packaging-constraints.md) 维护；本文件冻结只读。

---
title: CJS 主进程不再使用 import.meta.resolve，扩展清单用延迟再导出避开无效动态 import
status: active
date: 2026-10-02
scope: build
files:
  - cli/src/official-package-dir.ts
  - extensions/deferred-manifest.ts
  - extensions/multi-agent/embedded-runner.ts
  - extensions/wiki-rag/client.ts
  - electron-agent/src/features/visual/VisualCard.tsx
  - electron-agent/src/features/tools/ContextToolGroup.tsx
supersedes:
superseded_by:
---

## 背景

生产构建把 Electron main 打成 CJS 字节码。rolldown 遇到 `import.meta.resolve` 会把 `import.meta` 换成 `{}` 并报 `EMPTY_IMPORT_META`。`@earendil-works/pi-coding-agent` 的 exports 只有 `import` 条件。同一条构建里，`extensions/index.ts` 被 main 静态引用，又被 `embedded-runner` 从这条静态图内部动态引用，rolldown 报 `INEFFECTIVE_DYNAMIC_IMPORT`。渲染进程里 `platform/runtime` 和 `ToolExecution` 也是既静态又动态引用，动态 import 拆不出 chunk。

## 决定

`resolveInstalledPiPackageDir` 从 `import.meta.url` 所在目录向上找 `node_modules/@earendil-works/pi-coding-agent`。`import.meta.url` 在 CJS 产物里会改写成输出文件的 file URL。`embedded-runner` 改为动态 import `extensions/deferred-manifest.ts`，由它再导出 `manifestExtensions`。`pi-worker` 仍在设置 `PI_PACKAGE_DIR` 之后动态 import `extensions/index.ts`。`WikiClient`、`VisualCard`、`ContextToolGroup` 改为静态 import。

## 放弃的方案

- `transform.define` 把 `import.meta` 定义成 `{}`，或关掉 `checks.emptyImportMeta`：警告没了，`import.meta.resolve` 在生产包里仍是空对象。
- `createRequire(import.meta.url).resolve`：该包没有 `require` 导出条件，解析抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- 生产 main 改回 ESM：字节码保护要求 CJS。开发时 `electron-vite serve` 仍是 ESM。
- `embedded-runner` 静态 import `extensions/index.ts`：和 `index → multi-agent → embedded-runner` 成环。
- `pi-worker` 顶部静态 import 扩展：扩展图会在 `applyOfficialMainPackageDir` 之前加载。
- 关掉 `checks.ineffectiveDynamicImport`：以后真正拆不出去的动态 import 也不再提示。

## 后果

安装目录必须出现在输出文件的祖先 `node_modules` 里。`NODE_PATH` 或其他非祖先位置不再被 `import.meta.resolve` 找到；找不到时保持原来的 `PI_PACKAGE_DIR`。`deferred-manifest` 会多一个很小的异步 chunk，只为把环留到 `filterExtensionFactories` 调用时。不要改回对 `extensions/index.ts` 的直接动态 import，否则 `INEFFECTIVE_DYNAMIC_IMPORT` 会回来。
