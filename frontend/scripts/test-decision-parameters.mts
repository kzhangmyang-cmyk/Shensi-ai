import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { parseHTML } from 'linkedom';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const index = parseHTML(await readFile(`${root}index.html`, 'utf8')).document;
const css = (await Promise.all([...index.querySelectorAll('link[rel=stylesheet]')].map(link => readFile(`${root}${link.getAttribute('href')!.replace(/^\//, '')}`, 'utf8')))).join('\n');
const bundle = await build({ stdin: { resolveDir: root, contents: `
import {mountDecisionSimulation} from './src/decision-simulation/view';
window.submissions=[];
const api={list:async()=>[],get:async()=>{throw new Error('not used')},create:async input=>{window.submissions.push(input);throw new Error('合成保存失败，验证输入保留')}};
window.openDecision=()=>mountDecisionSimulation(document.querySelector('main'),api);
window.leaveDecision=()=>document.querySelector('main').replaceChildren();window.openDecision();
` }, bundle: true, format: 'esm', write: false, define: { 'import.meta.env': '{}', 'import.meta.url': JSON.stringify('http://127.0.0.1:45679/src/decision-simulation/analysis-view.ts') } });
const browser = await chromium.launch({ headless: true });
const output = '/tmp/shensi-decision-parameters-qa'; await mkdir(output, { recursive: true });
try {
  for (const theme of ['dark', 'light']) for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.endsWith('/assets/galaxy-cyan-brand.png')) return route.fulfill({ contentType: 'image/png', body: await readFile(`${root}src/decision-simulation/assets/galaxy-cyan-brand.png`) });
      if (url === 'http://127.0.0.1:45679/') return route.fulfill({ contentType: 'text/html', body: '<html></html>' });
      return route.abort();
    });
    await page.goto('http://127.0.0.1:45679/');
    await page.setContent(`<html data-theme="${theme}"><head><style>${css}</style></head><body data-session-workspace-id="fixture" data-session-user-id="user"><main style="max-width:1200px;margin:auto"></main></body></html>`);
    await page.addScriptTag({ content: 'window.__name=(fn)=>fn;' });
    await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text });
    assert.equal(await page.locator('.decision-simulation').getAttribute('data-atmosphere'), width < 700 ? 'paused' : 'running');
    if (width >= 700) {
      await page.locator('[data-atmosphere-toggle]').click();
      assert.equal(await page.locator('.decision-simulation').getAttribute('data-atmosphere'), 'paused');
      await page.locator('[data-atmosphere-toggle]').click();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.decision-simulation')?.dataset.atmosphere === 'paused');
      assert.equal(await page.locator('.decision-simulation').getAttribute('data-atmosphere'), 'paused');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.waitForFunction(() => document.querySelector<HTMLElement>('.decision-simulation')?.dataset.atmosphere === 'running');
    }
    await page.locator('[data-parameter-kind=receivables] summary').click();
    const amount = page.locator('[data-parameter-kind=receivables] [data-parameter=amountMinor]');
    await amount.fill('0.29'); await amount.press('Tab');
    await page.locator('[type=submit]').click();
    await page.getByText(/合成保存失败/).waitFor();
    assert.equal(await page.evaluate(() => (window as any).submissions[0].baseline.receivables[0].amountMinor), 29);
    assert.equal(await amount.inputValue(), '0.29');
    await page.locator('[data-step=agents]').click();
    await page.locator('[data-step=source]').click();
    assert.equal(await amount.inputValue(), '0.29');
    assert.equal(await page.locator('.decision-source-inspector').isVisible(), false);
    await page.locator('[data-source-files]').setInputFiles({name:'合成经营资料.csv',mimeType:'text/csv',buffer:Buffer.from('项目,金额\n现金,100')});
    await page.locator('[name=title]').fill('跨页保留的合成方案');
    await page.evaluate(() => (window as any).leaveDecision());
    await page.evaluate(() => (window as any).openDecision());
    assert.equal(await page.locator('[name=title]').inputValue(),'跨页保留的合成方案');
    assert.equal(await page.locator('[data-source-files]').evaluate((el:HTMLInputElement)=>el.files?.[0]?.name),'合成经营资料.csv');
    assert.equal(await amount.inputValue(),'0.29');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    const contrasts = await page.evaluate(() => {
      const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
      const luminance = (color: number[]) => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      return ['.decision-hero h2', '.decision-fields label', '[data-status]', '[data-step=source]', '[data-parameter=amountMinor]'].map(selector => {
        const el = document.querySelector(selector)!; const fg = rgb(getComputedStyle(el).color);
        let background = [255, 255, 255]; const chain: Element[] = []; let parent: Element | null = el;
        while (parent) { chain.unshift(parent); parent = parent.parentElement; }
        for (const node of chain) { const color = rgb(getComputedStyle(node).backgroundColor); const alpha = color[3] ?? 1; background = background.map((value, index) => color[index] * alpha + value * (1 - alpha)); }
        const values = [luminance(fg), luminance(background)].sort((a, b) => b - a); return { selector, ratio: (values[0] + .05) / (values[1] + .05) };
      });
    });
    for (const item of contrasts) assert.ok(item.ratio >= 4.5, `${theme} ${width} ${item.selector} contrast ${item.ratio}`);
    await page.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await page.close(); console.log(`PASS ${theme} ${width}`);
  }
} finally { await browser.close(); }
