'use strict';

const { defineConfig, devices } = require('@playwright/test');
const path = require('node:path');
const repository = path.resolve(__dirname, '..');

module.exports = defineConfig({
    testDir: __dirname,
    outputDir: path.join(repository, 'test-results'),
    fullyParallel: true,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 2 : undefined,
    timeout: 30000,
    expect: { timeout: 5000 },
    reporter: process.env.CI ? [['line'], ['html', { open: 'never', outputFolder: path.join(repository, 'playwright-report') }]] : 'list',
    use: {
        baseURL: 'http://127.0.0.1:4173',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ],
    webServer: {
        cwd: repository,
        command: 'node tests/server.cjs',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: false,
        timeout: 15000,
    },
});
