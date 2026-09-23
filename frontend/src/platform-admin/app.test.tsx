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
    if (String(path).includes('/overview')) return authorized ? response({ ...overview, revision: conflict ? 1 : 2 }) : response({ message: '请先完成运营身份验证' }, 401);
    if (String(path).endsWith('/session')) { if (!authorized) return response({ message: '验证码无效' }, 401); return response({ ok: true }); }
    if (String(path).endsWith('/enterprises')) {
      await new Promise<void>(resolve => { release = resolve; });
      if (conflict) { conflict = false; return response({ message: '版本冲突' }, 409); }
      return response({ ok: true });
    }
    if (String(path).endsWith('/plans')) return response({ ok: true });
    if (String(path).endsWith('/accounts')) return response(overview.accounts[0]);
    if (String(path).endsWith('/password-reset')) return response({ token: 'synthetic-single-use', expiresAt: '2026-09-21T00:15:00Z' });
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
    await click('账号'); await click('创建账号');
    const member = document.querySelector<HTMLFormElement>('.editor form')!;
    assert.match(member.textContent!, /合成测试企业/);
    for (const [name, value] of Object.entries({ name: '测试成员', account: 'synthetic-member', password: 'synthetic-member-password', reason: '增加席位成员' })) member.querySelector<HTMLInputElement>(`[name=${name}]`)!.value = value;
    await submit(member);
    assert.equal(requests.find(row => row.path.endsWith('/accounts'))!.body.value.account, 'synthetic-member');
    const rowForm = document.querySelector<HTMLFormElement>('td form')!;
    rowForm.querySelector<HTMLInputElement>('[name=reason]')!.value = '用户申请密码恢复';
    await act(async () => { const event = new window.Event('submit', { bubbles: true, cancelable: true }); const button = rowForm.querySelector<HTMLButtonElement>('[value=password-reset]')!; Object.defineProperty(button, 'value', { value: 'password-reset' }); Object.defineProperty(event, 'submitter', { value: button }); rowForm.dispatchEvent(event); });
    assert.ok([...document.querySelectorAll<HTMLInputElement>('input')].some(input => input.value === 'synthetic-single-use'));
    assert.equal(document.querySelector<HTMLAnchorElement>('a[href="/admin.html#reset"]')!.getAttribute('href'), '/admin.html#reset');
    await click('已保存，关闭凭证');
    assert.ok([...document.querySelectorAll<HTMLInputElement>('input')].every(input => input.value !== 'synthetic-single-use'));
    await click('操作日志');
    assert.ok(document.querySelector('[aria-label="搜索操作日志"]'));
  } finally { await act(async () => root.unmount()); Object.assign(globalThis, original); }
});

test('public reset validates confirmation, keeps errors visible, and clears successful credentials', async () => {
  const { document, window } = parseHTML('<html><body><main id="root"></main></body></html>');
  const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData, location: globalThis.location };
  Object.assign(globalThis, { document, window, location: { hash: '#reset' }, IS_REACT_ACT_ENVIRONMENT: true }); document.cookie = '';
  class BrowserFormData extends FormData { constructor(form?: HTMLFormElement) { super(); for (const node of form?.querySelectorAll<HTMLInputElement>('input') ?? []) this.append(node.name, node.value); } }
  globalThis.FormData = BrowserFormData;
  let requests = 0, reject = true;
  globalThis.fetch = async (path, options) => { assert.equal(path, '/api/auth/reset-password'); requests++; const body = JSON.parse(String(options!.body)); assert.equal(body.token, 'synthetic-token'); return reject ? response({ message: '恢复凭证已失效' }, 400) : response({ ok: true }); };
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<App/>));
    const form = document.querySelector<HTMLFormElement>('form')!;
    form.reset = () => { for (const input of form.querySelectorAll<HTMLInputElement>('input')) input.value = ''; };
    const set = (name: string, value: string) => { form.querySelector<HTMLInputElement>(`[name=${name}]`)!.value = value; };
    const submit = async () => act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    set('token', 'synthetic-token'); set('password', 'new-synthetic-password'); set('confirm', 'mismatch');
    await submit(); assert.equal(requests, 0); assert.match(document.body.textContent!, /两次输入的密码不一致/);
    set('confirm', 'new-synthetic-password'); await submit(); assert.equal(requests, 1); assert.match(document.body.textContent!, /恢复凭证已失效/);
    reject = false; await submit(); assert.match(document.body.textContent!, /密码已更新/); assert.equal(document.querySelector('form'), null);
    assert.ok([...form.querySelectorAll<HTMLInputElement>('input')].every(input => input.value === ''));
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

test('forbidden and business-conflict operations preserve inputs and the original server error', async () => {
  const { document, window } = parseHTML('<html><body><main id="root"></main></body></html>');
  document.cookie = '';
  const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData };
  Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });
  class BrowserFormData extends FormData { constructor(form?: HTMLFormElement) { super(); for (const node of form?.querySelectorAll<HTMLInputElement>('input') ?? []) this.append(node.name, node.value); } }
  globalThis.FormData = BrowserFormData;
  let mutationStatus = 403, mutationMessage = '当前账号无权执行此操作';
  globalThis.fetch = async path => String(path).includes('/overview') ? response(overview) : response({ message: mutationMessage }, mutationStatus);
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<App/>));
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '创建企业')!.click());
    const form = document.querySelector<HTMLFormElement>('.editor form')!;
    form.querySelector<HTMLInputElement>('[name=name]')!.value = '应保留的输入';
    await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.match(document.querySelector('[role=alert]')!.textContent!, /无权执行/);
    assert.equal(document.querySelector<HTMLInputElement>('[name=name]')!.value, '应保留的输入');
    assert.equal(document.querySelector('.login'), null);
    mutationStatus = 409;
    for (const message of ['企业席位已满', '该账号已存在']) {
      mutationMessage = message;
      await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
      assert.equal(document.querySelector('[role=alert]')!.textContent, message);
      assert.equal(document.querySelector<HTMLInputElement>('[name=name]')!.value, '应保留的输入');
      assert.equal(document.querySelector('.login'), null);
    }
  } finally { await act(async () => root.unmount()); Object.assign(globalThis, original); }
});
