import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

// Browser tests for the tab UI, run against the local dev harness (fixture
// plans, no Azure DevOps). Unit/DOM tests stay in Vitest (`npm test`).
export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        trace: 'retain-on-failure',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: {
        command: `npm run dev:prepare && node e2e/serve.mjs .dev ${PORT}`,
        url: `http://127.0.0.1:${PORT}/dev.html`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
