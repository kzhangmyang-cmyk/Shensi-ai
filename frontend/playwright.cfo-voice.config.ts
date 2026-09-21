import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: 'cfo-voice-settings.spec.ts', timeout: 20000,
  use: { baseURL: 'http://127.0.0.1:5199', channel: 'chrome', screenshot: 'only-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5199 --mode desktop',
    url: 'http://127.0.0.1:5199', reuseExistingServer: false } });
