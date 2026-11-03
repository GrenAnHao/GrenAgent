import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Preserve the vendored panel's upstream regressions alongside host tests.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vendor/repo-wiki/apps/web/src/workspace/test-setup.ts'],
    include: ['vendor/repo-wiki/apps/web/src/workspace/**/*.test.{ts,tsx}'],
  },
});
