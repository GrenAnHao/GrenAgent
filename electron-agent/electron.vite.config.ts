import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import { copyPiAdjacentAssets } from "./electron/agent/copyPiAdjacentAssets";
import { ignoreNonFrontendWatch, isFrontendHmrPath } from "./electron/dev/frontendWatch";
import { removeMainCjsPackageJson, writeMainCjsPackageJson } from "./electron/agent/writeMainCjsPackageJson";
import { installDevElectronHeapArg } from "./electron/mainHeap";

installDevElectronHeapArg();

const mainInput = {
  main: resolve(__dirname, "electron/main.ts"),
  "pi-worker": resolve(__dirname, "electron/pi-worker-entry.ts"),
  // 交互运行时所在的子进程（ELECTRON_RUN_AS_NODE）。主进程只经 IPC 和它对话。
  "agent-host": resolve(__dirname, "electron/agentProcess/hostEntry.ts"),
  // AgentData 运行时所在的子进程（ELECTRON_RUN_AS_NODE）：agent-data.db 的唯一持有者。
  "agentdata-host": resolve(__dirname, "electron/agentDataProcess/hostEntry.ts"),
  // CodeGraph SDK 的索引与查询所在的子进程（ELECTRON_RUN_AS_NODE）。
  "codegraph-host": resolve(__dirname, "electron/app/codeGraph/hostEntry.ts"),
  // codegraph-host 里的 SDK 工作线程（worker_threads）。
  "codegraph-worker": resolve(__dirname, "electron/app/codeGraph/workerEntry.ts"),
};

// electron-vite 6 默认 externalizeDeps: true，会把 package.json 的 dependencies 全部外置。
// 生产主进程要求只外置下面这几个原生模块（已 asarUnpack）：
// - Pi SDK 的 exports 只有 import 条件，外置后 CJS 里 require 它抛 ERR_PACKAGE_PATH_NOT_EXPORTED；
// - agent-host / pi-worker 的 chunk 在 app.asar.unpacked 里加载，往上找 node_modules 找不到 asar 里的 yaml 等包。
const mainExternal = [
  "@homebridge/node-pty-prebuilt-multiarch",
  "@colbymchenry/codegraph",
  "@ast-grep/napi",
  "@vscode/ripgrep",
  /^node:/,
];

export default defineConfig(({ command, mode }) => {
  // npm run start（--mode localrun）：渲染层用生产构建，主进程保持开发时的 ESM。
  // CJS 字节码产物 require 不到只有 import 条件的 pi 包，本机直接跑起不来。
  const production = command === "build" && mode !== "localrun";
  return {
    main: {
      resolve: {
        dedupe: [
          "@earendil-works/pi-coding-agent",
          "@earendil-works/pi-ai",
          "@earendil-works/pi-agent-core",
        ],
      },
      build: {
        ...(production
          ? {
              bytecode: { transformArrowFunctions: false },
              externalizeDeps: false,
            }
          : {}),
        rollupOptions: {
          input: mainInput,
          // package.json 是 type: module，rolldown 对 CJS 默认出 .cjs / .cjsc。
          // main 字段、asarUnpack 和 out/main/package.json（commonjs）都按 .js / .jsc 约定，这里显式钉住。
          ...(production
            ? {
                output: {
                  format: "cjs" as const,
                  entryFileNames: "[name].js",
                  chunkFileNames: "chunks/[name]-[hash].js",
                },
              }
            : {}),
          external: mainExternal,
        },
      },
      plugins: [
        {
          name: "copy-pi-adjacent-assets",
          closeBundle() {
            const outDir = resolve(__dirname, "out/main");
            copyPiAdjacentAssets(resolve(__dirname, ".."), outDir);
            if (production) writeMainCjsPackageJson(outDir);
            else removeMainCjsPackageJson(outDir);
          },
        },
      ],
    },
    preload: {
      build: {
        rollupOptions: {
          input: {
            preload: resolve(__dirname, "electron/preload.ts"),
            webviewPreload: resolve(__dirname, "electron/browser/webviewPreload.ts"),
          },
          output: {
            format: "cjs",
            entryFileNames: "[name].js",
          },
        },
      },
    },
    renderer: {
      root: resolve(__dirname),
      plugins: [
        {
          name: "frontend-only-hmr",
          hotUpdate(ctx) {
            if (!isFrontendHmrPath(ctx.file, resolve(__dirname))) return [];
          },
        },
      ],
      server: {
        // 避开 Vite 默认 5173，减少和其他前端项目抢端口。
        port: 31415,
        // 服务一启动就顺着入口把源码转译好，和 Electron 主进程加载并行；不预热时窗口要等几百个模块逐个转译。
        warmup: { clientFiles: ["./src/main.tsx"] },
        // 只侦测前端源码。主进程、扩展、测试和 out/ 的写入不再把窗口打进整页刷新。
        watch: {
          ignored: (path) => ignoreNonFrontendWatch(path, resolve(__dirname)),
        },
      },
      resolve: {
        alias: {
          "@extensions": resolve(__dirname, "../extensions"),
        },
        // @pierre/diffs 同时被 @lobehub/ui（CodeDiff）和我们自己的流式高亮视图引用。
        // 两份副本就是两个 getSharedHighlighter 单例和两份自定义主题注册表，
        // lobe 注册的 lobe-theme 在另一份里解析不到，流式视图会直接退回纯文本。
        dedupe: ["@pierre/diffs"],
      },
      build: {
        outDir: resolve(__dirname, "dist"),
        rollupOptions: {
          input: resolve(__dirname, "index.html"),
        },
      },
    },
  };
});
