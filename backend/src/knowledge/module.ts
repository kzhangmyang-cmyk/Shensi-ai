import type { Pool } from 'mysql2/promise';
import type { GrowthCommercialModule } from '../growth-commercial-composition.js';
import { defineGrowthPrivateServiceKey } from '../growth-commercial-private-services.js';
import { GROWTH_FOUNDATION_SERVICES } from '../growth-foundation-module.js';
import { createKnowledgeCrypto } from './crypto.js';
import { createKnowledgeFileStore } from './file-store.js';
import { ensureKnowledgeMysqlSchema, MysqlKnowledgeRepository } from './mysql-repository.js';
import { KnowledgeService } from './service.js';
import { createKnowledgeRouter } from './router.js';
import { KnowledgeIngestionWorker, type KnowledgeIngestionOptions } from './ingestion-worker.js';
import { type KnowledgeReader } from './reader-gateway.js';
import { createConfiguredKnowledgeReader } from './pre-extracted-reader.js';
import { KnowledgeRetriever, type KnowledgeRetrievalOptions, type KnowledgeRetrievalPort } from './retrieval.js';
import { assertKnowledgeScope } from './domain.js';

export const KNOWLEDGE_SERVICE = defineGrowthPrivateServiceKey<KnowledgeService>('knowledge-service');
export const KNOWLEDGE_RETRIEVER = defineGrowthPrivateServiceKey<KnowledgeRetrievalPort>('knowledge-retriever');
export function createKnowledgeModule(options: { mode: 'disabled' } | { mode: 'mysql'; pool: Pool; root?: string; secret?: string;
  reader?: KnowledgeReader; readerConfigurationError?:'knowledge_reader_configuration_invalid';
  authorizeJob?: KnowledgeIngestionOptions['authorizeJob']; authorizeScope?: KnowledgeRetrievalOptions['authorizeScope']; indexVersion?: KnowledgeIngestionOptions['indexVersion'] }): GrowthCommercialModule {
  let installed = false;
  return { name: 'knowledge', async install(input) {
    if (installed) throw new Error('DUPLICATE_KNOWLEDGE_INSTALL'); installed = true;
    let service = new KnowledgeService({ reason: options.mode==='mysql'&&options.readerConfigurationError?options.readerConfigurationError:'knowledge_configuration_missing' });
    let worker: KnowledgeIngestionWorker | undefined;
    let retriever: KnowledgeRetriever | undefined;
    if (options.mode === 'mysql' && options.root && options.secret && !options.readerConfigurationError) {
      let files, crypto;
      try { crypto = createKnowledgeCrypto(options.secret); files = createKnowledgeFileStore({ root: options.root, secret: options.secret }); await files.prepare(); }
      catch { service = new KnowledgeService({ reason: 'knowledge_storage_unavailable' }); }
      if (files && crypto && service.availability().reason === 'knowledge_configuration_missing') {
        await ensureKnowledgeMysqlSchema(options.pool);
        const repository = new MysqlKnowledgeRepository(options.pool, crypto);
        retriever = new KnowledgeRetriever(repository, { authorizeScope: options.authorizeScope });
        service = new KnowledgeService({ repository, files, crypto }, id => { worker?.cancel(id); }, (ctx, id) => retriever!.invalidate(ctx, id));
        if (options.authorizeJob) {
          worker = new KnowledgeIngestionWorker({ repository, files,
            reader: options.reader ?? createConfiguredKnowledgeReader({ python: process.env.SHENSI_KNOWLEDGE_READER_PYTHON,
              script: process.env.SHENSI_KNOWLEDGE_READER_SCRIPT,manifest:process.env.SHENSI_KNOWLEDGE_PREEXTRACTED_MANIFEST }),
            authorizeJob: options.authorizeJob, indexVersion: options.indexVersion ?? ((ctx, versionId) => retriever!.indexVersion(ctx, versionId)) });
          worker.start();
        }
      }
    }
    input.privateServices.provide(KNOWLEDGE_SERVICE, service);
    input.privateServices.provide(KNOWLEDGE_RETRIEVER, retriever ?? { async retrieve(ctx, _input, signal) {
      signal?.throwIfAborted(); assertKnowledgeScope(ctx, 'knowledge.read'); return { status: 'unavailable', sources: [] };
    }, async assertCurrent(ctx, input, signal) {
      signal?.throwIfAborted(); assertKnowledgeScope(ctx, 'knowledge.read');
      if (input.evidence.status === 'used' || input.evidence.sources.length) throw new Error('knowledge_reference_stale');
    } });
    input.router.use('/api/v1/knowledge', createKnowledgeRouter({ service, workspaceContext: input.privateServices.require(GROWTH_FOUNDATION_SERVICES).workspaceContext }));
    return { async close() { retriever?.close(); await Promise.all([service.close(), worker?.close()]); } };
  } };
}
