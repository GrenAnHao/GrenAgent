import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vendored panel regressions and the renderer-safe public request contract.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vendor/repo-wiki/apps/web/src/workspace/test-setup.ts'],
    include: ['vendor/repo-wiki/apps/web/src/workspace/**/*.test.{ts,tsx}', 'vendor/repo-wiki/packages/contracts/src/**/*.test.ts'],
  },
});
