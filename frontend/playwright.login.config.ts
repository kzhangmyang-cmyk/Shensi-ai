import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Keep visual/auth tests away from the developer's running product window.
export default defineConfig({
  ...base,
  testMatch: 'shensi-login.spec.ts',
  use: { ...base.use, baseURL: 'http://127.0.0.1:5396' },
  webServer: [
    {
      command: 'PORT=5397 node --import tsx tests/fixtures/douyin-mediacrawler-http-fixture.ts',
      url: 'http://127.0.0.1:5397/healthz',
      reuseExistingServer: false,
    },
    {
      command: 'VITE_API_TARGET=http://127.0.0.1:5397 node node_modules/vite/bin/vite.js --mode desktop --host 127.0.0.1 --port 5396',
      url: 'http://127.0.0.1:5396/',
      reuseExistingServer: false,
    },
  ],
});
