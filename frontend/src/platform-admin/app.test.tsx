import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { App } from './app';
import type { components } from '../generated/platform-admin';

const overview: components['schemas']['Overview'] = { revision: 1, role: 'owner', page: 1, pageSize: 50, workspaceCount: 1, accountCount: 1, auditCount: 1,
  workspaces: [{ id: 'synthetic-enterprise', name: '合成测试企业', contact: '测试联系人', status: 'pending', planVersionId: null, startsAt: null, expiresAt: null, revision: 1 }],
  accounts: [{ id: 'synthetic-user', name: '测试管理员', email: 'synthetic-admin', workspaceId: 'synthetic-enterprise', role: 'admin', status: 'active' }],
  plans: [{ id: 'trial-v1', code: 'trial', version: 1, features: [], seatLimit: null, durationDays: null, published: false }],
  audits: [{ id: 'synthetic-audit', actorId: 'synthetic-owner', action: 'enterprise.create', targetId: 'synthetic-enterprise', reason: '合成测试', occurredAt: '2026-09-21T00:00:00Z', revision: 1 }] };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('four admin pages, draft defaults, conflict-preserved input and mutation lock use only synthetic requests', async () => {
  const { document, window } = parseHTML('<html><body><main id="root"></main></body></html>');
  const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData };
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  document.cookie = '';
  // linkedom does not supply browser FormData; this serializes actual rendered controls.
  class BrowserFormData extends FormData {
    constructor(form?: HTMLFormElement) { super(); for (const node of form?.querySelectorAll<HTMLInputElement>('input,select') ?? []) {
      if (!node.name || (node.type === 'checkbox' && !node.checked)) continue;
      this.append(node.name, node.value || (node.type === 'checkbox' ? 'on' : ''));
    } }
  }
  globalThis.FormData = BrowserFormData;
  const requests: { path: string; body: any }[] = [];
  let authorized = false, conflict = true;
  let release: (() => void) | undefined;
  globalThis.fetch = async (path, options) => {
    requests.push({ path: String(path), body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (String(path).includes('/overview')) return authorized ? response({ ...overview, revision: conflict ? 1 : 2 }) : response({ message: '请先完成运营身份验证' }, 403);
    if (String(path).endsWith('/session')) { if (!authorized) return response({ message: '验证码无效' }, 401); return response({ ok: true }); }
    if (String(path).endsWith('/enterprises')) {
      await new Promise<void>(resolve => { release = resolve; });
      if (conflict) { conflict = false; return response({ message: '版本冲突' }, 409); }
      return response({ ok: true });
    }
    if (String(path).endsWith('/plans')) return response({ ok: true });
    throw new Error(`Unexpected synthetic request: ${path}`);
  };
  const root = createRoot(document.getElementById('root')!);
  const click = async (text: string) => { const button = [...document.querySelectorAll('button')].find(node => node.textContent === text)!; assert.ok(button, text); await act(async () => button.click()); };
  const submit = async (form: HTMLFormElement) => { await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }); };
  try {
    await act(async () => root.render(<App/>));
    assert.match(document.body.textContent!, /运营身份验证/);
    await submit(document.querySelector('.login form')!);
    assert.match(document.querySelector('[role=alert]')!.textContent!, /验证码无效/);
    authorized = true;
    await submit(document.querySelector('.login form')!);
    assert.match(document.body.textContent!, /合成测试企业/);
    for (const label of ['账号', '套餐授权', '操作日志', '企业客户']) { await click(label); assert.equal(document.querySelector('h1')!.textContent, label); }
    await click('创建企业');
    const form = document.querySelector<HTMLFormElement>('.editor form')!;
    for (const [name, value] of Object.entries({ name: '输入保留测试', contact: '合成联系人', account: 'synthetic-new', password: 'synthetic-only-password', reason: '合成创建' })) form.querySelector<HTMLInputElement>(`[name=${name}]`)!.value = value;
    await submit(form);
    await submit(form);
    assert.equal(requests.filter(row => row.path.endsWith('/enterprises')).length, 1);
    assert.ok([...document.querySelectorAll<HTMLButtonElement>('nav button')].every(button => button.disabled));
    await act(async () => release!());
    assert.equal(document.querySelector<HTMLInputElement>('[name=name]')!.value, '输入保留测试');
    assert.match(document.querySelector('[role=alert]')!.textContent!, /已保留您的输入/);
    await submit(form);
    assert.equal(requests[requests.length - 1]!.body.revision, 2);
    await act(async () => release!());
    assert.equal(document.querySelector('.editor'), null);
    await click('套餐授权'); await click('配置套餐版本');
    const plan = document.querySelector<HTMLFormElement>('.editor form')!;
    assert.ok([...plan.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].every(input => !input.checked));
    await submit(plan);
    const savedPlan = requests.find(row => row.path.endsWith('/plans'))!.body.value;
    assert.equal(savedPlan.published, false); assert.equal(savedPlan.seatLimit, null); assert.equal(savedPlan.durationDays, null); assert.deepEqual(savedPlan.features, []);
  } finally { await act(async () => root.unmount()); Object.assign(globalThis, original); }
});

test('late overview response cannot repopulate an unmounted admin surface', async () => {
  const { document, window } = parseHTML('<html><body><main id="root"></main></body></html>');
  document.cookie = '';
  const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  let resolve!: (value: Response) => void;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_path, options) => { signal = options?.signal; return new Promise<Response>(done => { resolve = done; }); };
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<App/>));
    assert.match(document.body.textContent!, /正在读取运营数据/);
    await act(async () => root.unmount());
    assert.equal(signal?.aborted, true);
    await act(async () => resolve(response(overview)));
    assert.equal(document.getElementById('root')!.textContent, '');
  } finally { Object.assign(globalThis, original); }
});
