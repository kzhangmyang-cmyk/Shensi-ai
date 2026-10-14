import {test,expect} from '@playwright/test';

for(const theme of ['dark','light']) for(const width of [1440,390]) {
  test(`background itself moves and pauses without moving role nodes: ${theme} ${width}`,async({page})=>{
    await page.setViewportSize({width,height:1000});
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.goto('/tests/decision-cosmos-visual.html');
    await page.locator(`button[data-theme=${theme}]`).click();
    await page.locator('[data-step=agents]').click();
    const background=page.locator('.decision-simulation > .decision-cosmos-background');
    const sample=()=>background.evaluate(el=>getComputedStyle(el).transform);
    const settle=()=>background.evaluate(async el=>{await Promise.all(el.getAnimations().map(a=>a.ready));await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));});
    const before=await sample();
    const node=page.locator('[data-analysis-node=founder]');
    const bounds=await node.boundingBox();
    await expect.poll(sample).not.toBe(before);
    expect(await node.boundingBox()).toEqual(bounds);
    await page.locator('[data-reduce-motion]').click();
    await expect(page.locator('.decision-analysis')).toHaveAttribute('data-motion','paused');
    await settle();
    const paused=await sample();await page.waitForTimeout(200);expect(await sample()).toBe(paused);
    await page.locator('[data-reduce-motion]').click();await expect.poll(sample).not.toBe(paused);
    await page.emulateMedia({reducedMotion:'reduce'});
    await expect(page.locator('.decision-analysis')).toHaveAttribute('data-motion','paused');
    expect(await background.evaluate(el=>el.getAnimations().length)).toBe(0);
    await page.emulateMedia({reducedMotion:'no-preference'});
    for(let i=0;i<2;i++){
      await page.locator('[data-step=source]').click();await settle();
      const stopped=await sample();await page.waitForTimeout(150);expect(await sample()).toBe(stopped);
      await page.locator('[data-step=agents]').click();await expect.poll(sample).not.toBe(stopped);
    }
    await expect(background).toHaveCount(1);
    expect(await background.evaluate(el=>el.getAnimations().length)).toBe(1);
  });
}
