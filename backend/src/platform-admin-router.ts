import { Router, type Request, type Response, type NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getStore } from './store.js';
import { requireAuth, sessionCookieOptions } from './auth.js';
import { AccountCommandError } from './account-command.js';
import { isPlatformMutationPending } from './account-mutation-state.js';
import { platformState, platformMember, platformMutation, verifyPlatformMfa, createPlatformEnterprise, updatePlatformEnterprise, savePlatformPlan, platformAccountAccess } from './platform-admin-service.js';
import { createPlatformAccount, issuePlatformPasswordReset, consumePlatformPasswordReset } from './platform-admin-service.js';
import { ReferenceAccessError, type ReferenceAuthorityReader } from './system-reference/authority.js';
import type { CentralOwner } from './system-reference/domain.js';

declare global { namespace Express { interface Request { referenceOwner?: CentralOwner; } } }

const developmentKey = randomBytes(48).toString('base64url');
function signingKey() {
  const key = process.env.JWT_SECRET;
  if (key && key.length >= 32) return key;
  if (process.env.NODE_ENV === 'production') throw new Error('platform_signing_key_required');
  return developmentKey;
}
const wrap = (handler: (req: Request, res: Response) => Promise<void> | void) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve().then(() => handler(req, res)).catch(next); };
const command = z.object({ revision: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(500), value: z.unknown() }).strict();
const COOKIE = 'shensi_platform';
const isReferenceAdmin = (req: Request) => new URL(req.originalUrl || req.url, 'http://localhost').pathname.startsWith('/api/platform/v1/system-reference/');

export function isolatedPreviewPasswordOnly(userId: string, mode: string, env: NodeJS.ProcessEnv = process.env) {
  let database: URL;
  try { database = new URL(env.DATABASE_URL ?? ''); } catch { return false; }
  return env.SHENSI_ADMIN_PREVIEW_PASSWORD_ONLY_USER_ID === userId
    && userId.length > 0
    && mode === 'mysql'
    && database.protocol === 'mysql:'
    && database.hostname === '127.0.0.1'
    && database.pathname === '/shensi_admin_preview'
    && env.BACKEND_HOST === '127.0.0.1'
    && env.PORT === '5680'
    && env.CORS_ORIGINS === 'http://localhost:5681,http://127.0.0.1:5680';
}

export function createPlatformAdminRouter(options: { reference?: { authority: ReferenceAuthorityReader; router: ReturnType<typeof Router> } } = {}) {
  const router = Router();
  router.use(requireAuth);
  router.use((req, res, next) => {
    if (isPlatformMutationPending(getStore())) {
      if (isReferenceAdmin(req)) { res.setHeader('Cache-Control', 'no-store'); res.status(409).json({ error: { code: 'reference_authorization_updating', message: '运营配置正在保存，请稍后重试' } }); }
      else res.status(409).json({ message: '运营配置正在保存，请稍后重试' });
      return;
    }
    next();
  });
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/session', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }), wrap(async (req, res) => {
    const passwordOnly = isolatedPreviewPasswordOnly(req.user!.id, getStore().mode);
    const version = passwordOnly
      ? (z.object({}).strict().parse(req.body), platformMember(getStore(), req.user!.id).sessionVersion)
      : await verifyPlatformMfa(getStore(), req.user!.id, z.object({ code: z.string().regex(/^\d{6}$/) }).strict().parse(req.body).code);
    const currentUser = getStore().users.find(user => user.id === req.user!.id && user.status === 'active');
    if (!currentUser || (currentUser.authVersion || 1) !== req.user!.authVersion) throw new AccountCommandError(401, '登录状态已失效');
    const token = jwt.sign({ version, authVersion: req.user!.authVersion, mfaVerified: !passwordOnly }, signingKey(), { algorithm: 'HS256', subject: req.user!.id, issuer: 'shensi-platform', audience: 'shensi-platform-console', expiresIn: '15m' });
    res.cookie(COOKIE, token, { ...sessionCookieOptions(), path: '/api/platform', maxAge: 15 * 60 * 1000 });
    res.json({ authenticated: true });
  }));
  router.delete('/session', wrap(async (req, res) => {
    const store = getStore();
    await platformMutation(store, req.user!.id, platformState(store).revision, 'revoke_platform_sessions', req.user!.id, '主动退出运营会话', draft => {
      draft.memberships.find(row => row.userId === req.user!.id)!.sessionVersion++;
    });
    res.clearCookie(COOKIE, { ...sessionCookieOptions(), path: '/api/platform', maxAge: undefined });
    res.json({ authenticated: false });
  }));
  router.use((req, res, next) => {
    try {
    const token = String(req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token) throw new AccountCommandError(401, '请完成运营身份验证');
    try {
      const claims = jwt.verify(decodeURIComponent(token), signingKey(), { algorithms: ['HS256'], issuer: 'shensi-platform', audience: 'shensi-platform-console' }) as jwt.JwtPayload;
      const member = platformMember(getStore(), req.user!.id);
      if (claims.sub !== req.user!.id || claims.version !== member.sessionVersion || claims.authVersion !== req.user!.authVersion) throw new Error('invalid');
      res.locals.referenceMfa = { verified: claims.mfaVerified === true, version: claims.version, authVersion: claims.authVersion };
    } catch { throw new AccountCommandError(401, '运营会话已失效，请重新验证'); }
    next();
    } catch (error) { next(error); }
  });
  if (options.reference) {
    const reference = options.reference;
    router.use('/system-reference', (req, res, next) => {
      void (async () => {
        // Only this new owner surface requires proven TOTP; legacy console
        // behavior and the isolated password-only preview remain unchanged.
        const proof = res.locals.referenceMfa;
        if (req.headers.authorization || !proof?.verified) throw new ReferenceAccessError(403, 'reference_mfa_required');
        const owner = await reference.authority.assertOwner(req.user!.id);
        if (owner.authVersion !== proof.authVersion || owner.sessionVersion !== proof.version) throw new ReferenceAccessError(401, 'reference_owner_session_invalid');
        req.referenceOwner = owner; next();
      })().catch(next);
    }, reference.router);
  }
  router.get('/overview', wrap((req, res) => {
    const store = getStore(), state = platformState(store), member = platformMember(store, req.user!.id);
    const page = z.coerce.number().int().min(1).max(100000).default(1).parse(req.query.page);
    const query = z.string().max(100).default('').parse(req.query.q).toLowerCase();
    const take = <T>(rows: T[]) => rows.slice((page - 1) * 50, page * 50);
    const workspaces = state.workspaces.filter(row => `${row.name} ${row.id}`.toLowerCase().includes(query));
    const accounts = store.users.filter(user => state.workspaces.some(row => row.id === user.teamId) && `${user.name} ${user.email}`.toLowerCase().includes(query)).map(user => ({ id: user.id, name: user.name, email: user.email, workspaceId: user.teamId, role: user.role, status: user.status }));
    const audits = [...state.audits].reverse().filter(row => `${row.actorId} ${row.action} ${row.targetId} ${row.reason}`.toLowerCase().includes(query));
    res.json({ revision: state.revision, role: member.role, page, pageSize: 50, workspaces: take(workspaces), workspaceCount: workspaces.length, accounts: take(accounts), accountCount: accounts.length, plans: state.plans, audits: take(audits), auditCount: audits.length });
  }));
  router.post('/accounts', wrap(async (req, res) => {
    const body = command.parse(req.body);
    res.status(201).json(await createPlatformAccount(getStore(), req.user!.id, body.revision, body.value, body.reason));
  }));
  router.post('/accounts/:id/password-reset', wrap(async (req, res) => {
    const body = command.parse(req.body); z.object({}).strict().parse(body.value);
    res.json(await issuePlatformPasswordReset(getStore(), req.user!.id, body.revision, String(req.params.id), body.reason));
  }));
  router.post('/enterprises', wrap(async (req, res) => {
    const body = command.parse(req.body);
    res.status(201).json(await createPlatformEnterprise(getStore(), req.user!.id, body.revision, body.value, body.reason));
  }));
  router.patch('/enterprises/:id', wrap(async (req, res) => {
    const body = command.parse(req.body);
    res.json(await updatePlatformEnterprise(getStore(), req.user!.id, body.revision, String(req.params.id), body.value, body.reason));
  }));
  router.post('/plans', wrap(async (req, res) => {
    const body = command.parse(req.body);
    res.status(201).json(await savePlatformPlan(getStore(), req.user!.id, body.revision, body.value, body.reason));
  }));
  router.patch('/accounts/:id', wrap(async (req, res) => {
    const body = command.parse(req.body), value = z.object({ action: z.enum(['disable', 'enable', 'revoke']) }).strict().parse(body.value);
    res.json(await platformAccountAccess(getStore(), req.user!.id, body.revision, String(req.params.id), value.action, body.reason));
  }));
  router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (error instanceof ReferenceAccessError) { res.status(error.status).json({ error: { code: error.code, message: '默认参考库维护权限校验未通过' } }); return; }
    if (isReferenceAdmin(req) && error instanceof AccountCommandError) { res.status(error.status).json({ error: { code: 'reference_owner_session_invalid', message: '请完成有效的运营身份验证' } }); return; }
    if (error instanceof AccountCommandError) { res.status(error.status).json({ message: error.message }); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ message: '输入格式不正确，请检查必填项和配置范围' }); return; }
    next(error);
  });
  return router;
}

export function createPlatformPasswordResetRouter() {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/', rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }), wrap(async (req, res) => {
    res.json(await consumePlatformPasswordReset(getStore(), req.body));
  }));
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof AccountCommandError) { res.status(error.status).json({ message: error.message }); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ message: '恢复凭证或密码格式不正确' }); return; }
    next(error);
  });
  return router;
}
