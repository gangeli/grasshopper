import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works under any GitHub Pages sub-path.
  base: './',
  build: { target: 'es2022', sourcemap: true },
  server: { host: true },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
} as any);
