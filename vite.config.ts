import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // Relative base so the build works under any GitHub Pages sub-path.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), lab: resolve(__dirname, 'lab.html') },
    },
  },
  server: { host: true },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
} as never);
