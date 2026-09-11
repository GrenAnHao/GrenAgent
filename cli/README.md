# cli —— 内嵌 SDK 装配与 worker 入口

源码仍在 `cli/`（`gren-runtime` / `pi-sdk` / `pi-worker` / `json-event`），由 electron-vite 打进 `electron-agent/out/main/`。桌面端不再编译独立 `pi.exe`，也不再走 `--mode rpc` JSONL 宿主。

## 入口

- `src/pi-sdk.ts`：Electron 主进程访问 SDK 的桶文件。
- `src/gren-runtime.ts`：`createGrenRuntime` 工厂。
- `src/pi-worker.ts`：子代理入口，只跑官方 `main()` 的 `--mode json` / print。
- `src/runtime.ts`：print 路径包装（banner + `main(argv, { extensionFactories })`）。
- `src/json-event.ts`：自持的 `toJsonEvent`，保证渲染层事件形状稳定。

## 测试

```bash
cd cli
npm test
npm run typecheck
```

## 升级 pi 时

对照仓库根 [`docs/pi-sdk-upgrade-checklist.md`](../docs/pi-sdk-upgrade-checklist.md)。
