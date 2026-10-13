> 已迁移：本决定现由 [.agents/notes/implemented/architecture/2026-09-29-codegraph-platform-binaries.md](../../../.agents/notes/implemented/architecture/2026-09-29-codegraph-platform-binaries.md) 维护；本文件冻结只读。

---
title: 用 minimumReleaseAgeExclude pattern 放行 codegraph 的外平台预编译二进制
status: active
date: 2026-09-29
scope: build
files:
  - electron-agent/pnpm-workspace.yaml
supersedes:
superseded_by:
---

## 背景

`pnpm dev` 在 Windows 上被 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 挡住，报
`@colbymchenry/codegraph-{darwin-arm64,darwin-x64,linux-arm64,linux-x64}@1.6.0`
「could not be checked against minimumReleaseAge (version not present in registry manifest)」。

三条实测事实推翻了报错的字面意思：

1. 注册表上 1.6.0 对 7 个 codegraph 包（父包 + 6 个平台包）全部存在，1.6.1 也已发布。
   所以不是「版本没发布」。
2. pnpm 元数据缓存（`%LOCALAPPDATA%\pnpm-cache\v11\metadata{,-full}`）里根本没有
   `@colbymchenry` 目录。不是缓存过期，是从来没取过。
3. 失败的恰好是 4 个非 win32 平台包；本机真正安装的 win32-arm64 / win32-x64 都通过。

pnpm 11.6 起「为 optionalDependencies 推断平台字段，外平台二进制永不下载」，连 manifest
也不取；拿不到发布时间，`minimumReleaseAge`（pnpm 11.0 起默认 1440 分钟，仓库未配置也生效）
就把它们判为不可校验。这 4 条在 Windows 上**永远**过不了，与网络、缓存、版本号无关。

触发时机是 `pnpm <script>` 的前置依赖校验：`package.json` 新增 `@pierre/diffs` 后
node_modules 状态与 lockfile 不一致，于是 `pnpm dev` 先跑安装，安装入口做全 lockfile
供应链检查（1365 条）而非只检查待装的包。

## 决定

在 `electron-agent/pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里加一条 pattern：

```yaml
  - '@colbymchenry/codegraph-*'
```

pattern 形式自 pnpm 10.17 起支持（bare name / name glob / `pkg@version`）。父包
`@colbymchenry/codegraph` **不在**此列，仍受 24 小时成熟期约束——真正会执行安装脚本和
JS 的是父包，供应链信号在那里，平台包是同一次发布里的纯二进制附属物。

## 放弃的方案

- **逐条钉 `name@1.6.0`**（与相邻 `@earendil-works/*@0.87.0` 写法一致）：每次升级 codegraph
  都会以同样一条看不懂的报错再炸一次，而这 4 条在本机永远不可校验，把版本写进去没有任何
  校验价值。
- **清 pnpm 元数据缓存后联网重装**：缓存里本来就没有这 4 个包的条目，没有「过期」可清。
- **升到 1.6.1**：更新的版本只会更容易违反成熟期，且平台过滤机制完全一样。
- **全局关掉 `minimumReleaseAge`**（`pnpm config set minimum-release-age 0`）：为一类不可
  校验的平台二进制，把整机所有依赖的供应链冷却期一起废掉，代价不成比例。
- **`pnpm clean --lockfile` + 重新解析**（pnpm 帮助文本的建议）：lockfile 并不 stale——
  `pnpm install --frozen-lockfile` 通过证明了这一点；重新解析只会把同样的 4 条再写回去。
- **移除 `@colbymchenry/codegraph` 依赖**：它是 agentData 检索链路的真实依赖，不是可选项。

## 后果

- 这 6 个平台二进制不再有成熟期保护。风险由父包的成熟期检查兜住；若 codegraph 换成
  按平台包独立发布（平台包可以脱离父包单独发新版），这个假设失效，需要重新评估。
- pattern 会随 codegraph 升级自动继续生效，不需要跟着改版本号。
- 在 macOS / Linux 上检出本仓库时，失败的会变成 win32 那两条——同一条 pattern 已经覆盖，
  无需按平台再改。
- 校验：`pnpm install --frozen-lockfile` 输出
  `✓ Lockfile passes supply-chain policies (1365 entries in 2.2s)`；随后 `pnpm <script>`
  的日志里不再出现 install 与 policy check 两段，前置校验直接跳过。
