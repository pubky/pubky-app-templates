import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4175',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', testIgnore: '**/bfcache.spec.js', use: devices['Desktop Chrome'] },
    { name: 'firefox', testIgnore: '**/bfcache.spec.js', use: devices['Desktop Firefox'] },
    {
      name: 'chromium-bfcache',
      testMatch: '**/bfcache.spec.js',
      use: {
        ...devices['Desktop Chrome'],
        // Full Chromium's headless mode supports BFCache; headless-shell does not.
        channel: 'chromium',
        launchOptions: { ignoreDefaultArgs: ['--disable-back-forward-cache'] },
      },
    },
  ],
  webServer: {
    command: 'node tests/browser/serve.js',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
  },
})
