import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import { copyPiAdjacentAssets } from "./electron/agent/copyPiAdjacentAssets";

export default defineConfig({
  main: {
    resolve: {
      dedupe: [
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-ai",
        "@earendil-works/pi-agent-core",
      ],
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, "electron/main.ts"),
          "pi-worker": resolve(__dirname, "electron/pi-worker-entry.ts"),
        },
        external: [
          "@homebridge/node-pty-prebuilt-multiarch",
          "@colbymchenry/codegraph",
          "@ast-grep/napi",
          /^node:/,
        ],
      },
    },
    plugins: [
      {
        name: "copy-pi-adjacent-assets",
        closeBundle() {
          copyPiAdjacentAssets(resolve(__dirname, ".."), resolve(__dirname, "out/main"));
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
    build: {
      outDir: resolve(__dirname, "dist"),
      rollupOptions: {
        input: resolve(__dirname, "index.html"),
      },
    },
  },
});
