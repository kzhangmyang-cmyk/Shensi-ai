import { expect, test } from '@playwright/test';

test('six selected roles send their real contract role and show the matching avatar without cross-role history', async ({ page }) => {
  await page.route('**/__roles_fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/src/replica-dashboard.css"><body style="background:#0b100d;padding:12px"><main style="max-width:1000px;margin:auto"></main>
    <script type="module">
    import { mountCfoConversation } from '/src/growth/agents/cfo-conversation.ts';
    window.requests=[];
    mountCfoConversation({host:document.querySelector('main'),scope:()=> 'fixture-ws:actor',http:{request:async(path,input)=>{
      window.requests.push(input.body);return {body:{answer:'角色职责核对完成，仍需本期已验证资料。',model:'fixture-text-model',material:null}}}}});
    </script>` }));
  await page.setViewportSize({ width: 1440, height: 960 }); await page.goto('/__roles_fixture');
  await expect(page.locator('.cfo-agent-portrait img')).toHaveAttribute('src', '/assets/business-advisor-agents/cfo.jpg');
  await expect(page.locator('.cfo-chat-empty')).toBeVisible();
  for (const role of ['cfo', 'finance', 'profit', 'cost', 'cashflow', 'tax']) {
    await page.locator(`[data-cfo-role-choice="${role}"]`).click();
    await page.locator('#cfoQuestion').fill('请按你的职责分析目前缺少哪些资料。');
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.locator('[data-role=assistant]')).toHaveCount(1);
    await expect(page.locator('[data-role=assistant] img')).toHaveAttribute('src', `/assets/business-advisor-agents/${role}.jpg`);
    await expect(page.locator('.cfo-agent-portrait img')).toHaveAttribute('src', `/assets/business-advisor-agents/${role}.jpg`);
    await expect(page.locator('.cfo-chat-empty')).not.toBeVisible();
    const input = await page.evaluate(() => (window as any).requests.at(-1));
    expect(input.role).toBe(role); expect(input.history).toEqual([]);
    if (role !== 'cfo') await expect(page.locator('.cfo-voice-entry')).not.toBeVisible();
  }
  await page.locator('.cfo-conversation').screenshot({ path: '/tmp/shensi-specialist-chat-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.cfo-conversation').screenshot({ path: '/tmp/shensi-specialist-chat-narrow.png' });
});

test('voice settings saves privately, reports real state and fits desktop and narrow windows', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  await page.route('**/__voice_fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shensi · 经营总管语音设置</title>
    <link rel="stylesheet" href="/src/replica-dashboard.css"></head><body style="background:#0b100d;padding:24px"><main></main>
    <script type="module">
    import { mountCfoConversation } from '/src/growth/agents/cfo-conversation.ts';
    let view={state:'not_configured',configured:false,workspaceId:'',model:'qwen3.5-omni-flash-realtime',region:'cn-beijing',checkedAt:null};
    window.shensiCfoRealtime={settings:async()=>view,save:async(ws,input)=>{if(window.failSave)throw new Error('voice_storage_unavailable');window.savedScope=ws;return view={...view,configured:true,workspaceId:input.workspaceId,state:'saved'}},
      check:async()=>view={...view,state:'credentials_failed'},remove:async()=>view={...view,state:'not_configured',configured:false,workspaceId:''},help:async()=>{}};
    document.body.dataset.sessionWorkspaceId='fixture-ws';
    mountCfoConversation({host:document.querySelector('main'),scope:()=> 'fixture-ws:actor',http:{request:async()=>({body:{answer:'请提供本期回款明细。',model:'fixture-text-model',material:null}})}});
    </script></body></html>` }));
  await page.goto('/__voice_fixture');
  await expect(page).toHaveTitle('Shensi · 经营总管语音设置');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.locator('#cfoQuestion').fill('保留这个未发送的问题');
  await page.getByRole('button', { name: '语音服务设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '实时语音服务配置' }); await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('尚未配置');
  await expect(dialog.locator('[name=apiKey]')).toHaveAttribute('type', 'password');
  await dialog.screenshot({ path: '/tmp/shensi-cfo-voice-desktop.png' });
  // Fake credentials are confined to this isolated fixture; never sent to Main or Bailian.
  await dialog.locator('[name=apiKey]').fill('fixture-only-not-a-key');
  await dialog.locator('[name=workspaceId]').fill('https://not-a-workspace.test');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toContainText('业务空间 ID 格式不正确');
  await expect(dialog.locator('[name=apiKey]')).toHaveValue('fixture-only-not-a-key');
  expect(await page.evaluate(() => (window as any).savedScope)).toBeUndefined();
  await dialog.locator('[name=workspaceId]').fill('fixture-workspace');
  await page.evaluate(() => { (window as any).failSave = true; });
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toContainText('系统安全存储不可用');
  await expect(dialog.locator('[name=apiKey]')).toHaveValue('fixture-only-not-a-key');
  await expect(dialog.locator('[name=workspaceId]')).toHaveValue('fixture-workspace');
  await page.evaluate(() => { (window as any).failSave = false; });
  await dialog.locator('[name=workspaceId]').fill('');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(dialog).toContainText('已保存，尚未检测');
  await expect(dialog.locator('[name=workspaceId]')).toHaveValue('');
  await expect(dialog.locator('[name=apiKey]')).toHaveValue('');
  expect(await page.evaluate(() => (window as any).savedScope)).toBe('fixture-ws');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('fixture-only');
  await dialog.getByRole('button', { name: '检测连接' }).click();
  await expect(dialog).toContainText('API Key 无效或已失效');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await dialog.screenshot({ path: '/tmp/shensi-cfo-voice-narrow.png' });
  await dialog.getByRole('button', { name: '移除配置' }).click(); await expect(dialog).toContainText('尚未配置');
  await dialog.getByRole('button', { name: '关闭语音服务设置' }).click(); await expect(dialog).not.toBeVisible();
  await expect(page.locator('#cfoQuestion')).toHaveValue('保留这个未发送的问题');
  await page.getByRole('button', { name: '发送问题' }).click(); await expect(page.locator('[data-cfo-turns]')).toContainText('请提供本期回款明细');
  expect(errors).toEqual([]);
});

test('realtime Renderer plays streamed silent PCM, acknowledges playback, interrupts and closes audio', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__audio_fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/src/replica-dashboard.css"><body style="background:#0b100d;padding:12px"><button>开始隔离音频测试</button><section class="cfo-conversation"><div class="cfo-turns"></div></section>
    <script type="module">
    import { CfoRealtimeClient } from '/src/growth/agents/cfo-realtime-client.ts';
    import { mountCfoChatMessages } from '/src/growth/agents/cfo-chat-messages.ts';
    import { BUSINESS_AGENT_TEAM } from '/src/growth/agents/agents.ts';
    const messages=mountCfoChatMessages({host:document.querySelector('.cfo-turns'),agent:BUSINESS_AGENT_TEAM[0],userName:'kamran'});
    messages.append({role:'user',text:'利润为什么不等于现金？'});
    let listener; const a=window.acceptance={acks:[],turns:[],errors:[],released:0,stopped:0};
    const bridge={start:async()=>({sessionId:'fixture-session'}),stop:async()=>{a.stopped++},onEvent:fn=>{listener=fn;return()=>{listener=undefined}},
      played:async(id,response,ms,done)=>{a.acks.push({response,ms,done})},audio:async()=>{}};
    const client=new CfoRealtimeClient({bridge,createAudio:()=>a.context=new AudioContext(),microphone:async()=>()=>{a.released++},
      onState:state=>a.state=state,onTurn:turn=>{a.turns.push(turn);messages.append(turn)},onPreview:p=>messages.preview(p),onBusiness(){},onError:code=>a.errors.push(code)});
    document.querySelector('button').onclick=()=>client.start('fixture-ws',[]);
    window.sendAudio=(id,seconds)=>{listener({sessionId:'fixture-session',type:'audio',responseId:id,pcm:btoa('\\0'.repeat(48000*seconds))});
      listener({sessionId:'fixture-session',type:'response_done',responseId:id,text:id})};
    window.interruptAudio=()=>listener({sessionId:'fixture-session',type:'interrupted'});window.stopAudio=()=>client.stop();
    window.streamWords=(id,text)=>listener({sessionId:'fixture-session',type:'transcript',responseId:id,text});
    </script>` }));
  await page.goto('/__audio_fixture'); await page.getByRole('button').click();
  await expect.poll(() => page.evaluate(() => (window as any).acceptance.state)).toBe('listening');
  await page.evaluate(() => (window as any).streamWords('fully-played', '利润'));
  const first = page.locator('article[data-role=assistant]').first(); await expect(first).toContainText('利润');
  await page.evaluate(() => { (window as any).firstBubble=document.querySelector('article[data-role=assistant]'); (window as any).streamWords('fully-played','利润和现金的口径不同。'); });
  await expect(first.locator('p')).toHaveText('利润和现金的口径不同。');
  expect(await page.evaluate(() => (window as any).acceptance.turns.length)).toBe(0);
  await expect(first.locator('img')).toHaveAttribute('src','/assets/business-advisor-agents/cfo.jpg');
  expect(await page.locator('article[data-role=user]').evaluate(el => getComputedStyle(el).flexDirection)).toBe('row-reverse');
  await page.locator('.cfo-conversation').screenshot({ path: '/tmp/shensi-cfo-stream-desktop.png' });
  await page.evaluate(() => (window as any).sendAudio('fully-played', .4));
  await expect.poll(() => page.evaluate(() => (window as any).acceptance.turns.length)).toBe(1);
  expect(await first.evaluate(el => el === (window as any).firstBubble)).toBe(true);
  await expect(first).toHaveAttribute('data-state','complete');
  await page.evaluate(() => (window as any).streamWords('interrupted', '这一段还没有完整播放，不能加入后续对话。'));
  await page.evaluate(() => (window as any).sendAudio('interrupted', .8));
  await expect.poll(() => page.evaluate(() => (window as any).acceptance.acks.some((ack: any) => ack.response === 'interrupted' && ack.ms > 0))).toBe(true);
  await page.evaluate(() => (window as any).interruptAudio());
  await expect(page.locator('[data-state=interrupted]')).toContainText('已打断');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.cfo-conversation').screenshot({ path: '/tmp/shensi-cfo-stream-narrow.png' });
  await page.evaluate(() => (window as any).stopAudio());
  await expect.poll(() => page.evaluate(() => (window as any).acceptance.context.state)).toBe('closed');
  const state = await page.evaluate(() => ({ ...(window as any).acceptance, context: undefined }));
  expect(state.turns).toEqual([{ role: 'assistant', text: 'fully-played' }]);
  expect(state.released).toBe(1); expect(state.stopped).toBeGreaterThan(0); expect(state.errors).toEqual([]); expect(errors).toEqual([]);
});

test('CFO chat uses compact typography and content-sized messages independent of surrounding dashboard scale', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  await page.route('**/__chat_fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shensi · 经营总管对话</title>
    <link rel="stylesheet" href="/src/replica-dashboard.css"></head><body style="background:#0b100d;padding:12px;font-size:32px"><main style="max-width:1040px;margin:auto"></main>
    <script type="module">
    import { mountCfoConversation } from '/src/growth/agents/cfo-conversation.ts';
    mountCfoConversation({host:document.querySelector('main'),scope:()=> 'fixture-ws:actor',http:{request:async()=>({body:{answer:'你好，有什么可以帮你？',model:'fixture-text-model',material:null}})}});
    </script></body></html>` }));
  await page.setViewportSize({ width: 1440, height: 960 }); await page.goto('/__chat_fixture');
  await expect(page).toHaveTitle('Shensi · 经营总管对话');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.locator('#cfoQuestion').fill('你好啊。'); await page.getByRole('button', { name: '发送问题', exact: true }).click();
  const user = page.locator('.cfo-turns article[data-role=user]').first(); await expect(user).toContainText('你好啊。');
  const size = await user.evaluate(el => ({ text: parseFloat(getComputedStyle(el.querySelector('p')!).fontSize),
    role: parseFloat(getComputedStyle(el.querySelector('strong')!).fontSize), height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width }));
  expect(size.text).toBeGreaterThanOrEqual(14); expect(size.text).toBeLessThanOrEqual(16);
  expect(size.role).toBeLessThanOrEqual(12); expect(size.height).toBeLessThan(80); expect(size.width).toBeLessThan(260);
  await page.locator('.cfo-conversation').screenshot({ path: '/tmp/shensi-cfo-chat-compact-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  for (let n = 0; n < 3; n++) {
    await page.locator('#cfoQuestion').fill('请结合最近三个月的回款与库存说明现金周转情况，并指出还缺哪些已验证资料。'.repeat(3));
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.locator('.cfo-turns article')).toHaveCount((n + 2) * 2);
  }
  const log = page.getByRole('log', { name: '本次对话' });
  expect(await log.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await log.evaluate(el => { el.scrollTop = 0; });
  await page.locator('.cfo-conversation').screenshot({ path: '/tmp/shensi-cfo-chat-compact-narrow.png' });
  expect(errors).toEqual([]);
});
