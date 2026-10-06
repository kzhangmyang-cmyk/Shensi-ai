import type { Pool } from 'mysql2/promise';
import type { GrowthCommercialModule } from '../growth-commercial-composition.js';
import { defineGrowthPrivateServiceKey } from '../growth-commercial-private-services.js';
import { GROWTH_FOUNDATION_SERVICES } from '../growth-foundation-module.js';
import { createKnowledgeCrypto } from './crypto.js';
import { createKnowledgeFileStore } from './file-store.js';
import { ensureKnowledgeMysqlSchema, MysqlKnowledgeRepository } from './mysql-repository.js';
import { KnowledgeService } from './service.js';
import { createKnowledgeRouter } from './router.js';

export const KNOWLEDGE_SERVICE = defineGrowthPrivateServiceKey<KnowledgeService>('knowledge-service');
export function createKnowledgeModule(options: { mode: 'disabled' } | { mode: 'mysql'; pool: Pool; root?: string; secret?: string }): GrowthCommercialModule {
  let installed = false;
  return { name: 'knowledge', async install(input) {
    if (installed) throw new Error('DUPLICATE_KNOWLEDGE_INSTALL'); installed = true;
    let service = new KnowledgeService({ reason: 'knowledge_configuration_missing' });
    if (options.mode === 'mysql' && options.root && options.secret) {
      let files, crypto;
      try { crypto = createKnowledgeCrypto(options.secret); files = createKnowledgeFileStore({ root: options.root, secret: options.secret }); await files.prepare(); }
      catch { service = new KnowledgeService({ reason: 'knowledge_storage_unavailable' }); }
      if (files && crypto && service.availability().reason === 'knowledge_configuration_missing') {
        await ensureKnowledgeMysqlSchema(options.pool);
        service = new KnowledgeService({ repository: new MysqlKnowledgeRepository(options.pool, crypto), files, crypto });
      }
    }
    input.privateServices.provide(KNOWLEDGE_SERVICE, service);
    input.router.use('/api/v1/knowledge', createKnowledgeRouter({ service, workspaceContext: input.privateServices.require(GROWTH_FOUNDATION_SERVICES).workspaceContext }));
    return { close: () => service.close() };
  } };
}
