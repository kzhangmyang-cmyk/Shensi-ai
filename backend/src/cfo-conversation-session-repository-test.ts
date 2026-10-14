import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { InMemoryCfoConversationSessionRepository, MysqlCfoConversationSessionRepository,
  type CfoConversationSession } from './cfo-conversation-session-repository.js';
import { workspace } from './financial-council-repository-contract-test.js';
const context = { ...workspace('ws-session'), role: 'admin' as const, capabilities: ['finance.council.run'] as const };
const fixture = (): CfoConversationSession => ({ sessionId: randomUUID(), revision: 1, title: '现金流追问', documentId: null,
  createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
  turns: [{ role: 'user', text: '如何改善现金流？' }, { role: 'assistant', text: '请补充本期收支明细。', model: 'fixture' }] });
test('CFO history isolates actors/workspaces and rejects stale writes without losing newer turns', async () => {
  const repo = new InMemoryCfoConversationSessionRepository(); const value = fixture();
  await repo.save(context, value, 0);
  assert.deepEqual(await repo.get(context, value.sessionId), value);
  const returned = (await repo.list(context))[0]; returned.turns[0].text = 'mutated';
  assert.equal((await repo.get(context, value.sessionId))?.turns[0].text, value.turns[0].text);
  for (const other of [{ ...context, actorId: 'other' }, { ...context, workspaceId: 'other' }]) {
    assert.equal(await repo.get(other, value.sessionId), null); assert.deepEqual(await repo.list(other), []);
  }
  const next = { ...value, revision: 2, turns: [...value.turns, { role: 'user' as const, text: '继续' }] };
  await repo.save(context, next, 1);
  await assert.rejects(repo.save(context, { ...next, title: 'stale' }, 1), /revision_conflict/);
  assert.deepEqual(await repo.get(context, value.sessionId), next);
  await assert.rejects(repo.list({ ...context, capabilities: [] }));
  await assert.rejects(repo.save(context, { ...value, turns: Array(101).fill(value.turns[0]) }, 0));
});
test('MySQL writes encrypted content and scopes update CAS; unknown failures are not successes', async () => {
  const calls: { sql: string; values: any[] }[] = []; let affectedRows = 1;
  const repo = new MysqlCfoConversationSessionRepository({ execute: async (sql: string, values: any[]) => {
    calls.push({ sql, values }); return [{ affectedRows }, []];
  } } as never);
  const value = fixture(); await repo.save(context, value, 0);
  const encrypted = calls[0].values[5];
  assert.match(encrypted, /^v1\./); assert.equal(encrypted.includes(value.title), false);
  await repo.save(context, { ...value, revision: 2 }, 1);
  assert.match(calls[1].sql, /workspace_id = \? AND actor_id = \? AND session_id = \? AND revision = \?/);
  assert.deepEqual(calls[1].values.slice(3), [context.workspaceId, context.actorId, value.sessionId, 1]);
  affectedRows = 0; await assert.rejects(repo.save(context, { ...value, revision: 3 }, 2), /revision_conflict/);
  const reader = new MysqlCfoConversationSessionRepository({ execute: async () => [[{ payload_encrypted: encrypted }], []] } as never);
  assert.deepEqual(await reader.get(context, value.sessionId), value);
  await assert.rejects(reader.get({ ...context, actorId: 'other' }, value.sessionId));
});
