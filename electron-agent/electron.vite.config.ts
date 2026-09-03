import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "electron/main.ts"),
        // Keep node-pty external so its native DLLs stay next to the .node binary.
        external: ["@homebridge/node-pty-prebuilt-multiarch"],
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
