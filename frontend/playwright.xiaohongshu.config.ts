import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',testMatch:'xiaohongshu.spec.ts',workers:1,
  use:{baseURL:'http://127.0.0.1:5397',channel:'chrome'},
  webServer:{command:'node node_modules/vite/bin/vite.js --mode desktop --host 127.0.0.1 --port 5397',
    url:'http://127.0.0.1:5397/tests/xiaohongshu-visual.html',reuseExistingServer:false,timeout:20000}});
