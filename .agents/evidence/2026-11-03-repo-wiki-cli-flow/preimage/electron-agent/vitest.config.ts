import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 测试按进程侧分成两个 project：electron/ 是主进程与 IPC 代码，跑在 node 环境；
 * src/ 是渲染层，需要 jsdom。此前没有这份配置，vitest 回落到空的 vite.config.ts，
 * 于是渲染层测试全靠各文件自己写 `// @vitest-environment jsdom` docblock —— 漏写的就报
 * `document is not defined`。在这里统一声明后，新增测试文件不必再记得加那行。
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'main',
          include: ['electron/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: {
          alias: { '@extensions': fileURLToPath(new URL('../extensions', import.meta.url)) },
          // 与 electron.vite.config.ts 的 renderer 保持一致：@pierre/diffs 被 @lobehub/ui 和
          // 我们的流式高亮视图分别引用，两份副本就是两个主题注册表和两个高亮器单例，
          // lobe 注册的 lobe-theme 会解析不到（报 No valid theme loader registered）。
          dedupe: ['@pierre/diffs'],
        },
        test: {
          name: 'renderer',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          // 这份垫片（jest-dom matchers、antd App stub、matchMedia/ResizeObserver/localStorage）
          // 仓库里早就有，只是一直没有配置引用它，于是从未生效。
          setupFiles: ['./src/test/setup.ts'],
          // 重型气泡（markdown + shiki 高亮）首渲很慢，默认 5s 在并发跑全量时必然超时。
          testTimeout: 30_000,
          // 见 scripts/vitest-json-attribute-hooks.mjs：@lobehub 这类面向打包器发布的依赖被
          // externalize 后由 Node 原生 ESM 加载会在 import 阶段直接崩，钩子补上解析差异。
          // execArgv 必须写在 project 内——projects 默认不继承根级 test 配置。
          execArgv: ['--import', './scripts/vitest-register-loader.mjs'],
        },
      },
    ],
  },
});
