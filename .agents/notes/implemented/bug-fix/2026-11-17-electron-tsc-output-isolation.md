# Agent Note: 桌面 TypeScript 编译产物不与源码混放

Status: implemented

## Problem

`electron-agent` 的 `npm run build` 在 Goal 生命周期改动后报 9 个 `MISSING_EXPORT`。新的命名导出已经存在于 `.ts` 源码；构建实际解析到了同目录旧 `.js`。`tsconfig.node.json` 是没有 `outDir` 的 composite 项目，直接编译该项目会把 `.js` / `.d.ts` 写入 Electron、CLI 和扩展的源码目录。Git 本地排除规则隐藏了这些文件，不会阻止 Vite、Vitest 或 SDK 扩展加载器读取它们。

此前 Goal 定向验证为同一批旧产物加过临时测试 resolver，但它不覆盖产品构建或 SDK 动态加载。桌面构建报错后，修复公共的源码树布局，不为每个入口各写解析规则。

## Decision

`electron-agent/tsconfig.node.json` 的编译产物写到已忽略且不打包的 `electron-agent/tmp/tsc-node/`。保留 composite、源码范围、显式编译能力和桌面构建入口；需要指定其他输出目录的调用者仍可覆盖 `outDir`。本地已经生成在源码旁的文件按 `.git/info/exclude` 中的历史精确清单移到备份，不改受 Git 跟踪的文件，也不向每次构建加入自动删除。

## Alternatives considered

- **只移走报错的几个 `.js`**：能最快消除当前几个导出报错，但其他旧文件可能静默替代当前实现，下次显式编译仍会复发。
- **改 Vite 的解析优先级**：不必移动本地文件，但覆盖不了 SDK 动态扩展加载等其他入口，还会留下两份相同模块名的实现。
- **设 `noEmit`**：彻底停止该项目生成 JavaScript，适合只检查类型；这里保留现有显式编译用法，包括继承此项目后指定独立输出位置的本地配置。

## Consequences

正常源码解析无需定制，桌面产物路径和 Goal 行为不变。显式编译的输出移到独立目录；使用了源码树内生成文件的本地命令需改用新输出目录。旧工作区需一次性移走已确认的历史副产物，改配置不会回收过去写出的文件。

## Verification

- 修复前 `cd electron-agent && npm run build` 复现 9 个 `MISSING_EXPORT`。
- 移走本地精确清单中实际存在的 1646 个旧产物后，原 `npm run build` 通过，生成 `out-pkg/`。备份在 `electron-agent/tmp/tsc-in-place-backup-20261117-161629/`，`paths.txt` 记录原仓库相对路径。
- `cd electron-agent && pnpm exec tsc -p tsconfig.node.json --noCheck --listEmittedFiles --pretty false` 通过：1991 个输出（含增量元数据）全部位于 `tmp/tsc-node/`。这里检查编译输出位置，不把 `--noCheck` 当作类型验收。
- `cd extensions && pnpm exec vitest run goal/fold.test.ts goal/control.test.ts goal/goal-live.real.test.ts` 用默认解析通过，3 个文件 33 项。真实 SDK `loadExtensions` 直接加载仓库的 `extensions/goal/index.ts`，无加载错误，注册了 `goal` 命令；未使用源码 overlay。
