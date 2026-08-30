import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "electron/main.ts"),
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "electron/preload.ts"),
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
