import { defineConfig } from '@playwright/test';

// HOPPER_PORT lets several checkouts run their e2e suites side by side.
const port = Number(process.env.HOPPER_PORT ?? 5179);

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}/index.html`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
