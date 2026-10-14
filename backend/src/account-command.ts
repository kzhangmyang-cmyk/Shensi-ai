import { randomUUID } from 'node:crypto';
import { canManageAccount, canManageAccounts, canManageRole, hashPassword, publicUser } from './auth.js';
import type { CrmStore, PersistedStoreMutation } from './store.js';
import type { SessionUser, User, Role } from './types.js';
import { beginAccountMutation } from './account-mutation-state.js';

export interface AccountAuditEvent {
  id: string;
  actorId: string;
  targetId: string;
  workspaceId: string;
  action: 'create' | 'disable' | 'enable' | 'password' | 'revoke';
  occurredAt: string;
}

export class AccountCommandError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const queues = new WeakMap<CrmStore, Promise<unknown>>();
export async function persistAccountMutation<T>(store: CrmStore, mutation: () => PersistedStoreMutation<T>): Promise<T> {
  if (store.persistMutation) return store.persistMutation(mutation);
  const previous = queues.get(store) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const applied = mutation();
    try { await store.persist(); return applied.value; }
    catch (error) { applied.rollback(); throw error; }
  });
  queues.set(store, operation);
  try { return await operation; }
  finally { if (queues.get(store) === operation) queues.delete(store); }
}

function appendAudit(store: CrmStore, operator: SessionUser, target: User, action: AccountAuditEvent['action']) {
  const events = store.accountAuditEvents ??= [];
  const event: AccountAuditEvent = { id: randomUUID(), actorId: operator.id, targetId: target.id, workspaceId: target.teamId, action, occurredAt: new Date().toISOString() };
  events.push(event);
  return () => { const index = events.indexOf(event); if (index >= 0) events.splice(index, 1); };
}

function checkOperator(store: CrmStore, operator: SessionUser) {
  const current = store.users.find(user => user.id === operator.id);
  if (!current || current.status !== 'active' || (current.authVersion || 1) !== operator.authVersion || current.role !== operator.role || current.teamId !== operator.teamId) {
    throw new AccountCommandError(401, '登录状态已失效');
  }
  if (!canManageAccounts(operator)) throw new AccountCommandError(403, '无账号管理权限');
  if (operator.role === 'super_admin' && store.platformAdminStates?.[0]?.memberships.length) throw new AccountCommandError(403, '平台初始化后跨企业账号写入必须通过运营后台');
  if (store.platformAdminStates?.[0]?.workspaces.some(row => row.id === operator.teamId)) throw new AccountCommandError(403, '纳管企业账号请通过运营后台管理');
}

export async function createAccount(store: CrmStore, operator: SessionUser, input: { name: string; email: string; password: string; role: Role; teamId?: string }) {
  const password = await hashPassword(input.password);
  let release: (() => void) | undefined;
  try { return await persistAccountMutation(store, () => {
    checkOperator(store, operator);
    if (!canManageRole(operator, input.role)) throw new AccountCommandError(403, '无权创建该角色账号');
    const email = input.email.trim().toLowerCase();
    if (store.users.some(user => user.email.toLowerCase() === email)) throw new AccountCommandError(409, '账号邮箱已存在');
    const teamId = operator.role === 'super_admin' ? (input.role === 'super_admin' ? 'all' : input.teamId?.trim()) : operator.teamId;
    if (!teamId) throw new AccountCommandError(400, '超级管理员创建账号时必须指定团队编号');
    if (store.platformAdminStates?.[0]?.workspaces.some(row => row.id === teamId)) throw new AccountCommandError(403, '纳管企业账号请通过运营后台管理');
    if (input.role === 'admin' && store.users.some(user => user.role === 'admin' && user.teamId === teamId)) throw new AccountCommandError(409, '该团队已存在管理员，每个公测团队只允许一名管理员');
    const user: User = { id: `u_${randomUUID()}`, name: input.name.trim(), email, password, role: input.role, teamId, avatar: input.name.trim().slice(0, 2).toUpperCase(), status: 'active', authVersion: 1 };
    release = beginAccountMutation(user.id);
    store.users.unshift(user);
    const undoAudit = appendAudit(store, operator, user, 'create');
    return { value: user, rollback() { const index = store.users.indexOf(user); if (index >= 0) store.users.splice(index, 1); undoAudit(); } };
  }); } finally { release?.(); }
}

export async function updateAccountAccess(store: CrmStore, operator: SessionUser, id: string, action: Exclude<AccountAuditEvent['action'], 'create'>, newPassword?: string) {
  const password = action === 'password' && newPassword ? await hashPassword(newPassword) : undefined;
  if (action === 'password' && !password) throw new AccountCommandError(400, '密码不能为空');
  let release: (() => void) | undefined;
  try { return await persistAccountMutation(store, () => {
    checkOperator(store, operator);
    const user = store.users.find(row => row.id === id);
    if (!user) throw new AccountCommandError(404, '账号不存在');
    if (store.platformAdminStates?.[0]?.workspaces.some(row => row.id === user.teamId)
      || store.platformAdminStates?.[0]?.memberships.some(row => row.userId === user.id)) throw new AccountCommandError(403, '纳管账号或平台身份必须通过运营管理流程修改');
    if (user.id === operator.id && action === 'disable') throw new AccountCommandError(400, '不能停用当前登录账号');
    if (!canManageAccount(operator, publicUser(user))) throw new AccountCommandError(404, '账号不存在');
    if (action === 'disable' && user.role === 'super_admin' && !store.users.some(row => row.id !== id && row.role === 'super_admin' && row.status === 'active')) throw new AccountCommandError(409, '不能停用最后一位超级管理员');
    const previous = { status: user.status, password: user.password, authVersion: user.authVersion };
    release = beginAccountMutation(user.id);
    if (action === 'disable') user.status = 'disabled';
    if (action === 'enable') user.status = 'active';
    if (password) user.password = password;
    user.authVersion = (user.authVersion || 1) + 1;
    const undoAudit = appendAudit(store, operator, user, action);
    return { value: user, rollback() { Object.assign(user, previous); undoAudit(); } };
  }); } finally { release?.(); }
}
