import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.js',
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    ...(process.env.E2E_CHROMIUM_EXECUTABLE ? {
      launchOptions: { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE }
    } : {})
  },
  webServer: {
    command: 'node e2e/server.js',
    url: 'http://127.0.0.1:3100/health',
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 }
  }
});
