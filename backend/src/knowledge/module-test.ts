import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createKnowledgeModule, KNOWLEDGE_SERVICE, KNOWLEDGE_RETRIEVER } from './module.js';
import { knowledgeContext } from '../../test/knowledge-fixture.js';
import { createGrowthPrivateServiceRegistry } from '../growth-commercial-private-services.js';
import { createGrowthFoundationModule } from '../growth-foundation-module.js';
import { createGrowthAcquisitionWorkspaceResolver } from '../growth-workspace-context.js';
import { createGrowthCommercialToolPorts } from '../growth-commercial-application.js';
import type { Pool } from 'mysql2/promise';

test('missing knowledge configuration disables only the knowledge service without a memory fallback', async () => {
  const input = { router: express.Router(), privateServices: createGrowthPrivateServiceRegistry(), toolPorts: createGrowthCommercialToolPorts() };
  const foundation = createGrowthFoundationModule({ mode: 'memory', acquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({ resolve: async () => null }) });
  const foundationHandle = await foundation.install(input);
  const handle = await createKnowledgeModule({ mode: 'disabled' }).install(input);
  const service = input.privateServices.require(KNOWLEDGE_SERVICE);
  assert.deepEqual(service.availability(), { available: false, reason: 'knowledge_configuration_missing' });
  const retriever = input.privateServices.require(KNOWLEDGE_RETRIEVER);
  assert.deepEqual(await retriever.retrieve(knowledgeContext(), { question: '预算', role: 'cfo' }), { status: 'unavailable', sources: [] });
  await handle.close(); await handle.close(); await foundationHandle.close();
});
test('an invalid trusted reader configuration disables knowledge without touching other services or SQL',async()=>{
  const input={router:express.Router(),privateServices:createGrowthPrivateServiceRegistry(),toolPorts:createGrowthCommercialToolPorts()};
  const foundation=await createGrowthFoundationModule({mode:'memory',acquisitionWorkspace:createGrowthAcquisitionWorkspaceResolver({resolve:async()=>null})}).install(input);
  const handle=await createKnowledgeModule({mode:'mysql',pool:{} as Pool,root:'/unused',secret:'unused',readerConfigurationError:'knowledge_reader_configuration_invalid'}).install(input);
  assert.deepEqual(input.privateServices.require(KNOWLEDGE_SERVICE).availability(),{available:false,reason:'knowledge_reader_configuration_invalid'});
  assert.deepEqual(await input.privateServices.require(KNOWLEDGE_RETRIEVER).retrieve(knowledgeContext(),{question:'预算',role:'cfo'}),{status:'unavailable',sources:[]});
  await handle.close();await foundation.close();
});
