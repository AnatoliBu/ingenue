import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  expect: {timeout: 7_500},
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', {outputFolder: 'playwright-report', open: 'never'}]]
    : [['list'], ['html', {outputFolder: 'playwright-report', open: 'never'}]],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: {width: 1440, height: 1000},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      args: ['--host-resolver-rules=MAP norns.local 127.0.0.1'],
    },
  },
  webServer: {
    command: 'node tests/browser/fixture-server.mjs',
    url: 'http://127.0.0.1:7780/__ingenue_midi_bridge__/health',
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
  },
});
