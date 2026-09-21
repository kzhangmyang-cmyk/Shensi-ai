import { createMysqlStore } from './mysql-store.js';
import { bootstrapPlatformOwner } from './platform-admin-service.js';

// Offline, deliberately excluded from HTTP. Never logs a URL, key or OTP seed.
async function main() {
  if (process.env.NODE_ENV !== 'production') throw new Error('production_environment_required');
  const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (!databaseUrl) throw new Error('database_required');
  const database = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!database || process.env.SHENSI_PLATFORM_BOOTSTRAP_CONFIRM_DATABASE !== database) throw new Error('explicit_database_confirmation_required');
  const userId = process.env.SHENSI_PLATFORM_BOOTSTRAP_USER_ID;
  const secret = process.env.SHENSI_PLATFORM_BOOTSTRAP_TOTP_SECRET;
  if (!userId || !secret) throw new Error('explicit_owner_and_mfa_required');
  const store = await createMysqlStore({ processRole: 'api' });
  try { await bootstrapPlatformOwner(store, userId, secret); console.log('PLATFORM_OWNER_INITIALIZED'); }
  finally { await store.close?.(); }
}
void main().catch(() => { console.error('平台所有者初始化失败：请检查目标数据库确认、独占API锁、已有账号和私密MFA配置。未输出连接信息或密钥。'); process.exitCode = 1; });
