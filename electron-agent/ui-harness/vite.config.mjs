import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import config from './harness.config.mjs'
import { depsGraphPlugin } from './depsGraph.mjs'
import { distDir } from './distDir.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 场景页面的构建配置。产物放系统临时目录（distDir.mjs）：不进 git，
 * 仓库在网盘同步目录里时也不会被同步拖慢。run.mjs 按同一个路径加载。
 *
 * 插件、别名、define 要和正式渲染层构建一致（electron.vite.config 的 renderer 段），
 * 否则场景里的组件和线上不是同一份产物。
 */
export default defineConfig({
  root: here,
  base: './',
  envDir: resolve(here, config.envDir),
  // depsGraphPlugin 记下「哪个场景用到哪些源文件」，check.mjs 靠它跳过多余的构建、按改动选场景，别删
  plugins: [react(), depsGraphPlugin()],
  resolve: {
    alias: Object.fromEntries(
      Object.entries(config.alias).map(([key, value]) => [key, resolve(here, value)])
    ),
    dedupe: config.dedupe ?? []
  },
  build: {
    outDir: distDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 99999,
    reportCompressedSize: false
  },
  logLevel: 'warn'
})
