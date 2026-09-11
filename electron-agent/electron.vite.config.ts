import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, "electron/main.ts"),
          "pi-worker": resolve(__dirname, "electron/pi-worker-entry.ts"),
        },
        // Preserve native binaries and CodeGraph's relative worker/grammar paths.
        external: ["@homebridge/node-pty-prebuilt-multiarch", "@colbymchenry/codegraph"],
      },
    },
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
