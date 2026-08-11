import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * 必须解析成「单实例」的包。这些库靠 React Context 传状态，同一个包存在两份副本
 * = 两个 Context 对象，跨副本读不到彼此的 Provider。
 *
 * antd 未去重时的具体后果：antd-style 的 ConfigProvider 把暗色主题写进副本 A 的
 * ConfigContext，而 @lobehub/ui 内部那个 <ConfigProvider theme={{ components }}> 属于
 * 副本 B、读不到父级主题 → 退回 antd 默认浅色，并把整份浅色 --ant-* 挂到
 * #root > div.ant-app 上。该节点是全树祖先，于是所有 cssVar.*（即 var(--ant-*)）
 * 消费者在暗色下都取到浅色值：输入框整块白底、正文深灰、图标与背景糊在一起。
 *
 * 触发过这个 bug 的重复源已经从安装层清掉了（当时 node_modules 是 bun 根目录 + 遗留
 * .pnpm 的混合布局，antd-style 等 12 个包仍是指向 .pnpm 的符号链接、各自带着旧版对等依赖；
 * 另有几处包把 react 钉在旧版 optional peer 上，被装成嵌套副本 —— 现已由 package.json
 * 的 overrides 收敛）。这份 dedupe 保留作纵深防御：它只管打包器解析，管不到 node_modules
 * 的真实形态，也管不到 Vitest 的 node 侧解析（所以当年这个 bug 打挂了整套测试却没打挂 app）。
 */
const DEDUPE_PACKAGES = [
  'react',
  'react-dom',
  'zustand',
  'lexical',
  '@lexical/utils',
  '@base-ui/react',
  'antd',
  'antd-style',
  '@ant-design/cssinjs',
  '@ant-design/cssinjs-utils',
  '@lobehub/ui',
];

export default defineConfig(async () => ({
  plugins: [react()],

  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          // 重依赖单独懒加载分包（与核心 UI 运行时无循环引用）。
          if (id.includes('mermaid') || id.includes('cytoscape')) return 'mermaid';
          if (id.includes('/shiki/') || id.includes('monaco-editor')) return 'highlighter';
          // 核心 UI 运行时：react / react-dom / antd / antd-style / @lobehub/ui / motion 彼此
          // 紧密依赖，必须同处一个 chunk。若拆成多个 chunk 会形成循环 chunk 依赖（antd ↔
          // react-vendor ↔ lobe-ui ↔ motion），生产构建里按加载顺序初始化时会出现某个 chunk
          // 的导出仍为 undefined，导致启动即崩、白屏/永久卡在加载页。
          if (
            id.includes('/react/') ||
            id.includes('react-dom') ||
            id.includes('/scheduler/') ||
            id.includes('/antd/') ||
            id.includes('antd-style') ||
            id.includes('@lobehub/') ||
            id.includes('/motion/') ||
            id.includes('/framer-motion/')
          ) {
            return 'vendor';
          }
        },
      },
    },
  },

  resolve: {
    dedupe: DEDUPE_PACKAGES,
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
}));
