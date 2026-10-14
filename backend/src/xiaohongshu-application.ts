import type mysql from 'mysql2/promise';
import { Router } from 'express';
import type { AcquisitionDesktopInstallationService } from './acquisition-desktop-installation-service.js';
import { MemoryXhsMessagingRepository, XiaohongshuMessagingService } from './xiaohongshu-messaging.js';
import { MysqlXhsMessagingRepository, XHS_MESSAGING_SCHEMA } from './xiaohongshu-messaging-mysql.js';
import { XhsAccountService } from './xiaohongshu-accounts.js';
import { createXhsMessagingRouter } from './xiaohongshu-messaging-router.js';

export async function createXhsApplication(options:{
  pool:Pick<mysql.Pool,'execute'>|null;
  installationService:Pick<AcquisitionDesktopInstallationService,'authenticateDevice'>;
  enabled?:boolean; dailyLimit?:number; moduleEnabled?:boolean;
}) {
  if(!(options.moduleEnabled ?? process.env.XHS_MODULE_ENABLED==='true')) {
    const router=Router();
    router.use((_req,res)=>{res.status(503).json({error:'xhs_module_unavailable'});});
    return router;
  }
  // Use the host runtime's persistence mode, never a fallback on database errors.
  if(options.pool) await options.pool.execute(XHS_MESSAGING_SCHEMA);
  const repository=options.pool ? new MysqlXhsMessagingRepository(options.pool) : new MemoryXhsMessagingRepository();
  const accounts=new XhsAccountService(repository);
  const service=new XiaohongshuMessagingService(repository,{enabled:options.enabled===true,dailyLimit:options.dailyLimit,
    account:(scope,id,device)=>accounts.resolve(scope,id,device)});
  return createXhsMessagingRouter({service,accounts,installationService:options.installationService});
}
