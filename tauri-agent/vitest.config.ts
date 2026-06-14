import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    server: {
      deps: {
        // @lobehub/ui 的 ESM 链路里有 JSON import attribute（emoji-mart），
        // 需走 Vite 转换管线才能在 node 下加载（组件测试用）。
        inline: [/@lobehub\/ui/, /@emoji-mart/],
      },
    },
  },
});
