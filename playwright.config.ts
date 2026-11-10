import { defineConfig, devices } from '@playwright/test';

const PORT = 4719;

/** Viewer end-to-end: the built dashboard (`bun run build`) over the demo
 *  data (`bun run viewer:demo`), in headless Chromium. */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [['list'], ['junit', { outputFile: 'e2e-junit.xml' }]]
    : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    headless: true,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `bun scripts/serve-stats.ts viewer/.demo ${PORT}`,
    url: `http://127.0.0.1:${PORT}/data/index.json`,
    reuseExistingServer: !process.env.CI,
  },
});
