import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { capabilitiesForHumanRole } from './growth-capabilities.js';
import type { ActiveWorkspaceContext } from './growth-workspace-context.js';

const context: ActiveWorkspaceContext = { workspaceId:'workspace', actorId:'actor', teamId:'team', kind:'personal', role:'admin',
  capabilities:capabilitiesForHumanRole('admin'), capabilityRegistryVersion:'growth-capabilities.v1' };
const draft = { id:'00000000-0000-4000-8000-000000000001', accountId:'account', deviceId:'device', recipientId:'recipient', body:'synthetic message' };
async function setup(enabled = true, limit = 20) {
  assert.ok(existsSync(new URL('./xiaohongshu-messaging.ts', import.meta.url)), 'independent approval authority exists');
  const { XiaohongshuMessagingService, MemoryXhsMessagingRepository } = await import('./xiaohongshu-messaging.js');
  const repository = new MemoryXhsMessagingRepository();
  const clock = { now:1_000_000 };
  const binding = { active:true, generation:'generation', accountId:'account', deviceId:'device' };
  const service = new XiaohongshuMessagingService(repository, { enabled, dailyLimit:limit, clock:()=>clock.now,
    account:async () => ({ ...binding }) });
  return { service, repository, clock, binding };
}

test('XHS defaults disabled and requires approval capability', async () => {
  const { service } = await setup(false);
  await assert.rejects(service.create(context, draft), /sending_disabled/);
  const enabled = (await setup()).service;
  await assert.rejects(enabled.create({...context, capabilities:[]}, draft), /能力不足/);
});

test('XHS exact revision approval is invalidated when recipient or body changes', async () => {
  const { service } = await setup();
  await service.create(context, draft);
  await service.approve(context, draft.id, 1);
  const updated = await service.edit(context, draft.id, 2, {recipientId:'new-recipient', body:'new body'});
  assert.equal(updated.status, 'draft');
  await assert.rejects(service.claim(context, 'device', draft.id, 2), /revision_conflict/);
  await assert.rejects(service.claim(context, 'device', draft.id, 3), /not_approved/);
  await service.approve(context, draft.id, 3);
  const command = await service.claim(context, 'device', draft.id, 4);
  assert.equal(command.body, 'new body');
  assert.equal(command.recipientId, 'new-recipient');
  assert.equal(command.actorId, 'actor');
});

test('XHS cannot cross workspace actor device or account generation', async () => {
  const { service, binding } = await setup();
  await service.create(context, draft);
  await service.approve(context, draft.id, 1);
  for (const changed of [{workspaceId:'other'}, {actorId:'other'}]) {
    await assert.rejects(service.claim({...context,...changed}, 'device', draft.id, 2), /not_found/);
  }
  await assert.rejects(service.claim(context, 'other-device', draft.id, 2), /account_not_ready/);
  binding.generation = 'replacement';
  await assert.rejects(service.claim(context, 'device', draft.id, 2), /account_changed/);
});

test('XHS concurrent approval reserves quota atomically and does not oversubscribe', async () => {
  const { service } = await setup(true, 1);
  await service.create(context, draft);
  const second = {...draft, id:'00000000-0000-4000-8000-000000000002'};
  await service.create(context, second);
  const outcomes = await Promise.allSettled([service.approve(context,draft.id,1), service.approve(context,second.id,1)]);
  assert.equal(outcomes.filter(value=>value.status === 'fulfilled').length, 1);
  const states = await service.list(context);
  assert.equal(states.filter(value=>value.status === 'approved').length, 1);
});

test('XHS claim is issued once, expiry cannot be used, unknown cannot resend', async () => {
  const { service, clock } = await setup();
  await service.create(context,draft);
  await service.approve(context,draft.id,1);
  const command = await service.claim(context,'device',draft.id,2);
  await assert.rejects(service.claim(context,'device',draft.id,2), /revision_conflict|not_approved/);
  await service.receipt(context,'device',draft.id,command.clientMessageId,'generation',{status:'unknown'});
  await assert.rejects(service.approve(context,draft.id,4), /not_editable/);
  const second = {...draft,id:'00000000-0000-4000-8000-000000000002'};
  await service.create(context,second);
  await service.approve(context,second.id,1);
  clock.now += 301_000;
  await assert.rejects(service.claim(context,'device',second.id,2), /approval_expired/);
});

test('XHS receipt requires exact device mid generation and terminal state is immutable', async () => {
  const { service } = await setup();
  await service.create(context,draft);
  await service.approve(context,draft.id,1);
  const command = await service.claim(context,'device',draft.id,2);
  for (const [device,mid,generation] of [['other',command.clientMessageId,'generation'],['device','wrong','generation'],['device',command.clientMessageId,'wrong']]) {
    await assert.rejects(service.receipt(context,device!,draft.id,mid!,generation!,{status:'confirmed',serverMessageId:'server'}), /receipt_mismatch/);
  }
  await service.receipt(context,'device',draft.id,command.clientMessageId,'generation',{status:'confirmed',serverMessageId:'server'});
  await assert.rejects(service.receipt(context,'device',draft.id,command.clientMessageId,'generation',{status:'rejected',platformCode:3}), /receipt_conflict/);
  const records = await service.list(context);
  assert.equal(records[0]?.status,'confirmed');
  assert.equal(records[0]?.receipt?.serverMessageId,'server');
});

test('XHS abandoned claim becomes unknown and a late exact receipt can reconcile', async () => {
  const { service, clock } = await setup();
  await service.create(context,draft);
  await service.approve(context,draft.id,1);
  const command = await service.claim(context,'device',draft.id,2);
  clock.now += 301_000;
  assert.equal((await service.list(context))[0]?.status,'unknown');
  await service.receipt(context,'device',draft.id,command.clientMessageId,'generation',{status:'confirmed',serverMessageId:'late-server'});
  assert.equal((await service.list(context))[0]?.status,'confirmed');
});

test('XHS quota is checked again on claim after UTC day changes', async () => {
  const { service, clock } = await setup(true,1);
  clock.now = Date.parse('2026-09-25T23:59:59Z');
  await service.create(context,draft);
  await service.approve(context,draft.id,1);
  clock.now += 2000;
  const second = {...draft,id:'00000000-0000-4000-8000-000000000002'};
  await service.create(context,second);
  await service.approve(context,second.id,1);
  await assert.rejects(service.claim(context,'device',draft.id,2),/daily_limit/);
  assert.equal((await service.list(context)).filter(value=>value.status==='executing').length,0);
});
