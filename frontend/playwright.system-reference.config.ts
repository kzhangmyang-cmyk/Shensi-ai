import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests',testMatch:'system-reference.spec.ts',timeout:25_000,expect:{timeout:3000},workers:1,
  outputDir:'../.superpowers/sdd/system-default-reference-library-implementation/d8-browser-results',reporter:'list',
  use:{baseURL:'http://127.0.0.1:5394',browserName:'chromium',headless:true},
  webServer:{command:'node node_modules/vite/bin/vite.js --mode desktop --host 127.0.0.1 --port 5394 --strictPort',url:'http://127.0.0.1:5394/reference-approval.html',reuseExistingServer:false,timeout:20_000}
});
