import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests',testMatch:'knowledge-library.spec.ts',timeout:20_000,expect:{timeout:3000},workers:1,
  outputDir:'/tmp/shensi-knowledge-playwright-results',reporter:'list',
  use:{baseURL:'http://127.0.0.1:5393',browserName:'chromium',headless:true},
  webServer:{command:'node node_modules/vite/bin/vite.js --mode desktop --host 127.0.0.1 --port 5393 --strictPort',url:'http://127.0.0.1:5393/tests/knowledge-library.html',reuseExistingServer:false,timeout:20_000}
});
