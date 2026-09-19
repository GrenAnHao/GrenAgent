import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import { copyPiAdjacentAssets } from "./electron/agent/copyPiAdjacentAssets";
import { removeMainCjsPackageJson, writeMainCjsPackageJson } from "./electron/agent/writeMainCjsPackageJson";

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
            webviewPreload: resolve(__dirname, "electron/webviewPreload.ts"),
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
      resolve: {
        alias: {
          "@extensions": resolve(__dirname, "../extensions"),
        },
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
