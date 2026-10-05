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
};

const mainExternal = [
  "@homebridge/node-pty-prebuilt-multiarch",
  "@colbymchenry/codegraph",
  "@ast-grep/napi",
  "@vscode/ripgrep",
  /^node:/,
];

export default defineConfig(({ command }) => {
  const production = command === "build";
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
        ...(production ? { bytecode: { transformArrowFunctions: false } } : {}),
        rollupOptions: {
          input: mainInput,
          ...(production ? { output: { format: "cjs" as const } } : {}),
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
