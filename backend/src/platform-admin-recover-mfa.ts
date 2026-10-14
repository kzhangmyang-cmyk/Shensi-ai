import { createMysqlStore } from './mysql-store.js';
import { recoverPlatformMfaOffline } from './platform-admin-service.js';

async function main() {
  if (process.env.NODE_ENV !== 'production') throw new Error('production_environment_required');
  const url = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (!url) throw new Error('database_required');
  const database = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!database || process.env.SHENSI_PLATFORM_RECOVERY_CONFIRM_DATABASE !== database) throw new Error('explicit_database_confirmation_required');
  const userId = process.env.SHENSI_PLATFORM_RECOVERY_USER_ID;
  const secret = process.env.SHENSI_PLATFORM_RECOVERY_TOTP_SECRET;
  const reason = process.env.SHENSI_PLATFORM_RECOVERY_REASON;
  if (!userId || !secret || !reason) throw new Error('explicit_identity_secret_reason_required');
  const store = await createMysqlStore({ processRole: 'api' });
  try { await recoverPlatformMfaOffline(store, userId, secret, reason); console.log('PLATFORM_MFA_RECOVERED'); }
  finally { await store.close?.(); }
}
void main().catch(() => { console.error('运营MFA恢复失败，请检查目标数据库确认、独占API锁、运营身份和私密配置。'); process.exitCode = 1; });
