import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Heavy @lobehub/ui components are forced through the Vite transform (server.deps.inline
    // below), so a cold component render can exceed vitest's 5s default on slower/loaded
    // machines (Windows CI), surfacing as spurious "Test timed out" failures. Give renders headroom.
    //
    // 这是全套的下限，别在单个测试文件里用 vi.setConfig({ testTimeout }) 往下调：全量跑时 146 个
    // 文件互相抢 CPU，比这里更短的值只会变成随机挂（每轮换一批受害文件、单独跑又都过）。
    // 只有确实比这更慢的文件才该往上调（例：ExtensionsPanel.test.tsx 45s、ChatListView.test.tsx 60s）。
    testTimeout: 30000,
    hookTimeout: 30000,
    // 限并发：本套的开销 ~77% 花在每个文件的冷启动模块加载上（整套跑一次累计 setup ~1350s、
    // import ~760s，而真正的 tests 只有 ~500s），因为 server.deps.inline 让 @lobehub/ui 在每个
    // worker 里都要重新走一遍 Vite 转换，再加 jsdom，单个 worker 峰值接近 1GB。
    // Vitest 默认开到「逻辑核 - 1」（本机 19 个），内存和 CPU 双重打架后互相拖慢到越过 testTimeout，
    // 症状是每轮随机挂几个文件、受害者还每轮不同、单独跑又全过。这里是内存约束而非核数约束，
    // 所以给固定值而不是核数百分比。实测：19 个 worker 挂 4 个文件，6 个 worker 全绿（146/146）。
    maxWorkers: 6,
    server: {
      deps: {
        // @lobehub/ui 的 ESM 链路里有 JSON import attribute（emoji-mart），
        // 需走 Vite 转换管线才能在 node 下加载（组件测试用）。
        inline: [/@lobehub\/ui/, /@emoji-mart/],
      },
    },
  },
});
