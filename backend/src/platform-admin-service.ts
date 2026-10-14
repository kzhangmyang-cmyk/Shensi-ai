import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { hashPassword } from './auth.js';
import { beginAccountMutation, beginPlatformMutation, isPlatformMutationPending } from './account-mutation-state.js';
import { TOTP, Secret } from 'otpauth';
import { encryptAgentJobPayload, decryptAgentJobPayload } from './agent-job-security.js';
import { AccountCommandError, persistAccountMutation } from './account-command.js';
import { emptyPlatformState, planDraftSchema, summarizeCustomerAccess, type PlatformAdminState } from './platform-admin-domain.js';
import type { CrmStore } from './store.js';

export const platformState = (store: CrmStore) => store.platformAdminStates?.[0] ?? emptyPlatformState();
export const customerAccess = (store: CrmStore, workspaceId: string) => summarizeCustomerAccess(platformState(store), workspaceId, Date.now(), isPlatformMutationPending(store));
const mfaIdentity = (userId: string) => ({ id: userId, ownerId: userId, teamId: 'platform', jobType: 'platform-mfa.v1' });

export function platformMember(store: CrmStore, userId: string) {
  const member = platformState(store).memberships.find(row => row.userId === userId && row.status === 'active');
  const user = store.users.find(row => row.id === userId && row.status === 'active');
  if (!member || !user) throw new AccountCommandError(403, '无平台运营权限');
  return member;
}

export async function platformMutation<T>(store: CrmStore, actorId: string, expectedRevision: number, action: string, targetId: string, reason: string, operation: (draft: PlatformAdminState, onRollback: (undo: () => void) => void, onFinish: (finish: () => void) => void) => T) {
  const undos: (() => void)[] = [], finishes: (() => void)[] = [];
  try { return await persistAccountMutation(store, () => {
    platformMember(store, actorId);
    const previous = store.platformAdminStates;
    const current = platformState(store);
    if (current.revision !== expectedRevision) throw new AccountCommandError(409, '记录已更新，请刷新后重试');
    if (!reason.trim() || reason.length > 500) throw new AccountCommandError(400, '请填写500字以内的操作原因');
    const draft = structuredClone(current);
    finishes.push(beginPlatformMutation(store));
    let value: T;
    try { value = operation(draft, undo => undos.push(undo), finish => finishes.push(finish)); }
    catch (error) { for (const undo of undos.reverse()) undo(); throw error; }
    draft.revision++;
    draft.audits.push({ id: randomUUID(), actorId, action, targetId, reason: reason.trim(), occurredAt: new Date().toISOString(), revision: draft.revision });
    store.platformAdminStates = [draft];
    return { value, rollback() { store.platformAdminStates = previous; for (const undo of undos.reverse()) undo(); } };
  }); } finally { for (const finish of finishes) finish(); }
}

export async function bootstrapPlatformOwner(store: CrmStore, userId: string, base32Secret: string) {
  if (store.mode === 'mysql' && (process.env.AGENT_JOB_ENCRYPTION_KEY?.trim().length ?? 0) < 32) throw new AccountCommandError(400, '持久化运营身份必须配置稳定的AGENT_JOB_ENCRYPTION_KEY');
  if (!/^[A-Z2-7]{32,128}$/.test(base32Secret)) throw new AccountCommandError(400, 'MFA密钥格式无效');
  const secretEncrypted = encryptAgentJobPayload(mfaIdentity(userId), 'input', { secret: base32Secret });
  let release: (() => void) | undefined;
  try { return await persistAccountMutation(store, () => {
    if (platformState(store).memberships.length) throw new AccountCommandError(409, '平台所有者已经初始化');
    if (!store.users.some(row => row.id === userId && row.status === 'active' && row.role !== 'super_admin')) throw new AccountCommandError(404, '必须选择已有有效的普通企业账号，不能复用全局超级管理员');
    const previous = store.platformAdminStates;
    release = beginPlatformMutation(store);
    const state = emptyPlatformState();
    state.revision = 1;
    state.memberships.push({ userId, role: 'owner', status: 'active', secretEncrypted, lastOtpCounter: -1, sessionVersion: 1 });
    state.audits.push({ id: randomUUID(), actorId: userId, targetId: userId, action: 'bootstrap_owner', reason: '受控运维初始化', occurredAt: new Date().toISOString(), revision: 1 });
    store.platformAdminStates = [state];
    return { value: undefined, rollback() { store.platformAdminStates = previous; } };
  }); } finally { release?.(); }
}

export const newEnterpriseSchema = z.object({ name: z.string().trim().min(1).max(100), contact: z.string().trim().max(180), account: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/), password: z.string().min(8).max(128) }).strict();
export async function createPlatformEnterprise(store: CrmStore, actorId: string, revision: number, input: unknown, reason: string) {
  const body = newEnterpriseSchema.parse(input);
  const password = await hashPassword(body.password);
  const id = `workspace_${randomUUID()}`;
  return platformMutation(store, actorId, revision, 'create_enterprise', id, reason, (draft, undo, finish) => {
    const email = `${body.account}@shensi.local`;
    if (store.users.some(user => user.email.toLowerCase() === email)) throw new AccountCommandError(409, '账号已存在');
    const user = { id: `u_${randomUUID()}`, name: body.account, email, password, role: 'admin' as const, teamId: id, avatar: body.account.slice(0, 2).toUpperCase(), status: 'active' as const, authVersion: 1 };
    finish(beginAccountMutation(user.id));
    store.users.unshift(user);
    undo(() => { const index = store.users.indexOf(user); if (index >= 0) store.users.splice(index, 1); });
    const workspace = { id, name: body.name, contact: body.contact, status: 'pending' as const, planVersionId: null, startsAt: null, expiresAt: null, revision: 1 };
    draft.workspaces.push(workspace);
    return workspace;
  });
}

export const workspaceUpdateSchema = z.object({ status: z.enum(['pending', 'active', 'suspended']), planVersionId: z.string().max(80).nullable(), startsAt: z.string().datetime().nullable(), expiresAt: z.string().datetime().nullable() }).strict();
export async function updatePlatformEnterprise(store: CrmStore, actorId: string, revision: number, id: string, input: unknown, reason: string) {
  const body = workspaceUpdateSchema.parse(input);
  return platformMutation(store, actorId, revision, 'update_enterprise', id, reason, (draft, undo, finish) => {
    const workspace = draft.workspaces.find(row => row.id === id);
    if (!workspace) throw new AccountCommandError(404, '未找到纳管企业');
    if (body.status === 'active') {
      const plan = draft.plans.find(row => row.id === body.planVersionId && row.published);
      if (!plan || !body.startsAt || !body.expiresAt || Date.parse(body.startsAt) >= Date.parse(body.expiresAt)) throw new AccountCommandError(400, '开通必须选择已发布套餐和有效期限');
      if (plan.seatLimit === null || store.users.filter(user => user.teamId === id && user.status === 'active').length > plan.seatLimit) throw new AccountCommandError(409, '有效账号数超过套餐席位');
    }
    for (const user of store.users.filter(row => row.teamId === id)) {
      const previous = user.authVersion;
      finish(beginAccountMutation(user.id));
      user.authVersion = (previous || 1) + 1;
      undo(() => { user.authVersion = previous; });
    }
    Object.assign(workspace, body, { revision: workspace.revision + 1 });
    return workspace;
  });
}

export async function platformAccountAccess(store: CrmStore, actorId: string, revision: number, targetId: string, action: 'disable' | 'enable' | 'revoke', reason: string) {
  return platformMutation(store, actorId, revision, `account_${action}`, targetId, reason, (draft, undo, finish) => {
    const user = store.users.find(row => row.id === targetId);
    if (!user || !draft.workspaces.some(row => row.id === user.teamId)) throw new AccountCommandError(404, '未找到纳管账号');
    if (draft.memberships.some(row => row.userId === targetId)) throw new AccountCommandError(403, '运营身份不能通过客户账号接口修改');
    if (action === 'enable') {
      const workspace = draft.workspaces.find(row => row.id === user.teamId)!;
      const plan = draft.plans.find(row => row.id === workspace.planVersionId);
      if (plan?.published && plan.seatLimit !== null && user.status !== 'active' && store.users.filter(row => row.teamId === user.teamId && row.status === 'active').length >= plan.seatLimit) throw new AccountCommandError(409, '套餐席位已满');
    }
    const before = { status: user.status, authVersion: user.authVersion };
    finish(beginAccountMutation(user.id));
    if (action !== 'revoke') user.status = action === 'enable' ? 'active' : 'disabled';
    user.authVersion = (user.authVersion || 1) + 1;
    undo(() => Object.assign(user, before));
    return { id: user.id, status: user.status };
  });
}

export async function verifyPlatformMfa(store: CrmStore, userId: string, token: string, now = Date.now()) {
  if (!/^\d{6}$/.test(token)) throw new AccountCommandError(401, '验证码无效');
  let release: (() => void) | undefined;
  try { return await persistAccountMutation(store, () => {
    const membership = platformMember(store, userId);
    const secret = decryptAgentJobPayload(mfaIdentity(userId), 'input', membership.secretEncrypted).secret;
    if (typeof secret !== 'string') throw new Error('platform_mfa_secret_invalid');
    const totp = new TOTP({ secret: Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 });
    const delta = totp.validate({ token, timestamp: now, window: 1 });
    const counter = Math.floor(now / 30000) + (delta ?? 0);
    if (delta === null || counter <= membership.lastOtpCounter) throw new AccountCommandError(401, '验证码无效或已使用');
    const previous = store.platformAdminStates;
    release = beginPlatformMutation(store);
    const draft = structuredClone(platformState(store));
    draft.memberships.find(row => row.userId === userId)!.lastOtpCounter = counter;
    draft.revision++;
    store.platformAdminStates = [draft];
    return { value: membership.sessionVersion, rollback() { store.platformAdminStates = previous; } };
  }); } finally { release?.(); }
}

export async function savePlatformPlan(store: CrmStore, actorId: string, revision: number, input: unknown, reason: string) {
  const value = planDraftSchema.parse(input);
  if (platformMember(store, actorId).role !== 'owner') throw new AccountCommandError(403, '只有平台所有者可以修改套餐');
  return platformMutation(store, actorId, revision, 'save_plan', value.code, reason, draft => {
    const version = Math.max(0, ...draft.plans.filter(plan => plan.code === value.code).map(plan => plan.version)) + 1;
    const plan = { ...value, id: `${value.code}:${version}`, version };
    draft.plans.push(plan);
    return plan;
  });
}

export const newAccountSchema = z.object({ workspaceId: z.string().min(1).max(100), name: z.string().trim().min(1).max(100), account: newEnterpriseSchema.shape.account, password: newEnterpriseSchema.shape.password, role: z.enum(['manager', 'sales']) }).strict();
export async function createPlatformAccount(store: CrmStore, actorId: string, revision: number, input: unknown, reason: string) {
  const body = newAccountSchema.parse(input), password = await hashPassword(body.password), id = `u_${randomUUID()}`;
  return platformMutation(store, actorId, revision, 'create_account', id, reason, (draft, undo, finish) => {
    const workspace = draft.workspaces.find(row => row.id === body.workspaceId);
    if (!workspace) throw new AccountCommandError(404, '未找到纳管企业');
    const plan = draft.plans.find(row => row.id === workspace.planVersionId && row.published);
    if ((!plan || plan.seatLimit === null) && workspace.status !== 'pending') throw new AccountCommandError(409, '请先为企业配置已发布套餐');
    if (plan?.seatLimit != null && store.users.filter(row => row.teamId === workspace.id && row.status === 'active').length >= plan.seatLimit) throw new AccountCommandError(409, '套餐席位已满');
    const email = `${body.account}@shensi.local`;
    if (store.users.some(row => row.email.toLowerCase() === email)) throw new AccountCommandError(409, '账号已存在');
    const user = { id, name: body.name, email, password, role: body.role, teamId: workspace.id, avatar: body.name.slice(0, 2), status: 'active' as const, authVersion: 1 };
    finish(beginAccountMutation(id));
    store.users.unshift(user);
    undo(() => { const index = store.users.indexOf(user); if (index >= 0) store.users.splice(index, 1); });
    return { id, name: user.name, email, role: user.role, workspaceId: user.teamId, status: user.status };
  });
}

const resetHash = (token: string) => createHash('sha256').update(token).digest('hex');
export async function issuePlatformPasswordReset(store: CrmStore, actorId: string, revision: number, targetId: string, reason: string, now = Date.now()) {
  const token = randomBytes(32).toString('base64url'), expiresAt = new Date(now + 15 * 60_000).toISOString();
  return platformMutation(store, actorId, revision, 'issue_password_reset', targetId, reason, (draft, undo, finish) => {
    const user = store.users.find(row => row.id === targetId);
    if (!user || !draft.workspaces.some(row => row.id === user.teamId)) throw new AccountCommandError(404, '未找到纳管账号');
    if (draft.memberships.some(row => row.userId === targetId)) throw new AccountCommandError(403, '运营身份必须通过受控运维恢复');
    const previous = user.authVersion;
    finish(beginAccountMutation(user.id));
    user.authVersion = (previous || 1) + 1;
    undo(() => { user.authVersion = previous; });
    draft.passwordResets = (draft.passwordResets ?? []).filter(row => row.userId !== targetId && Date.parse(row.expiresAt) > now);
    draft.passwordResets.push({ tokenHash: resetHash(token), userId: targetId, expiresAt, authVersion: user.authVersion });
    return { token, expiresAt };
  });
}

export const passwordResetSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password: z.string().min(8).max(128) }).strict();
export async function consumePlatformPasswordReset(store: CrmStore, input: unknown, now?: number) {
  const body = passwordResetSchema.parse(input), password = await hashPassword(body.password);
  const finishes: (() => void)[] = [];
  try { return await persistAccountMutation(store, () => {
    const previous = store.platformAdminStates, state = platformState(store);
    const reset = state.passwordResets?.find(row => row.tokenHash === resetHash(body.token));
    const user = reset && store.users.find(row => row.id === reset.userId);
    const currentTime = now ?? Date.now();
    if (!reset || !user || !Number.isFinite(Date.parse(reset.expiresAt)) || Date.parse(reset.expiresAt) <= currentTime || reset.authVersion !== (user.authVersion || 1) || state.memberships.some(row => row.userId === user.id)) throw new AccountCommandError(400, '恢复凭证无效或已过期，请重新申请');
    const before = { password: user.password, authVersion: user.authVersion };
    finishes.push(beginPlatformMutation(store), beginAccountMutation(user.id));
    const draft = structuredClone(state);
    draft.passwordResets = draft.passwordResets!.filter(row => row.userId !== user.id);
    draft.revision++;
    draft.audits.push({ id: randomUUID(), actorId: user.id, targetId: user.id, action: 'consume_password_reset', reason: '使用一次性恢复凭证修改密码', occurredAt: new Date(currentTime).toISOString(), revision: draft.revision });
    user.password = password; user.authVersion = (user.authVersion || 1) + 1;
    store.platformAdminStates = [draft];
    return { value: { completed: true }, rollback() { Object.assign(user, before); store.platformAdminStates = previous; } };
  }); } finally { finishes.forEach(finish => finish()); }
}

// Deliberately only exposed to an offline operator with explicit database confirmation.
export async function recoverPlatformMfaOffline(store: CrmStore, userId: string, base32Secret: string, reason: string) {
  if (!/^[A-Z2-7]{32,128}$/.test(base32Secret)) throw new AccountCommandError(400, 'MFA密钥格式无效');
  if (store.mode === 'mysql' && (process.env.AGENT_JOB_ENCRYPTION_KEY?.trim().length ?? 0) < 32) throw new AccountCommandError(400, '恢复必须配置稳定加密密钥');
  const secretEncrypted = encryptAgentJobPayload(mfaIdentity(userId), 'input', { secret: base32Secret });
  return platformMutation(store, userId, platformState(store).revision, 'recover_platform_mfa', userId, reason, (draft, undo, finish) => {
    const member = draft.memberships.find(row => row.userId === userId)!;
    const user = store.users.find(row => row.id === userId)!;
    const previous = user.authVersion;
    finish(beginAccountMutation(userId));
    user.authVersion = (previous || 1) + 1;
    undo(() => { user.authVersion = previous; });
    member.secretEncrypted = secretEncrypted; member.lastOtpCounter = -1; member.sessionVersion++;
  });
}
