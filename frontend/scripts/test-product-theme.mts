import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const result = await build({ entryPoints: ['src/theme.ts'], bundle: true, format: 'iife', globalName: 'ProductTheme', write: false });
const init = await readFile('public/theme-init.js', 'utf8');
const css = await readFile('src/theme.css', 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (url.pathname === '/theme-init.js') return route.fulfill({ contentType: 'text/javascript', body: init });
    await route.fulfill({ contentType: 'text/html', body: `<html><head><script src="/theme-init.js"></script><style>${css}</style></head><body><button data-theme-toggle>Theme</button><div id="settings"></div></body></html>` });
  });
  const page = await context.newPage();
  const mount = async (port: number) => {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.addScriptTag({ content: result.outputFiles[0].text + ';ProductTheme.installProductTheme(document);' });
  };
  await mount(47701);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.getByRole('button', { name: '切换到蓝白浅色' }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  const colors = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ['--theme-text','--theme-muted','--theme-surface','--theme-accent','--theme-on-accent'].map(name => style.getPropertyValue(name).trim());
  });
  const luminance = (hex: string) => {
    const values = [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255)
      .map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
    return values[0]*.2126+values[1]*.7152+values[2]*.0722;
  };
  for (const [foreground,background] of [[colors[0],colors[2]],[colors[1],colors[2]],[colors[4],colors[3]]]) {
    const pair=[luminance(foreground),luminance(background)].sort((a,b)=>b-a);
    const ratio=(pair[0]+.05)/(pair[1]+.05);
    assert.ok(ratio >= 4.5, `${foreground}/${background}: ${ratio}`);
    console.log(`contrast ${foreground}/${background}: ${ratio.toFixed(2)}:1`);
  }
  await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'head bootstrap restores before controller');
  await mount(47702);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'appearance survives desktop port changes');
  await page.evaluate(() => { document.querySelector('#settings')!.innerHTML = '<button data-theme-choice="dark">黑绿深色</button><button data-theme-choice="light">蓝白浅色</button>'; });
  await page.getByRole('button', { name: '黑绿深色', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.getByRole('button', { name: '蓝白浅色', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await page.waitForFunction(() => ![...document.querySelectorAll('style')].some(s => s.textContent === '*,*::before,*::after{transition:none!important}'));
  await context.addCookies([{ name: 'shensi_theme', value: 'unexpected', url: 'http://127.0.0.1:47702/' }]);
  await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'invalid persisted values fail to default');
  console.log('PASS theme default, switch, early restore, changed port, dynamic settings, keyboard, transition cleanup, invalid preference');
  await context.close();
} finally { await browser.close(); }
