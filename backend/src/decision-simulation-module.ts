import type mysql from 'mysql2/promise';
import type { GrowthCommercialModule } from './growth-commercial-composition.js';
import { GROWTH_FOUNDATION_SERVICES } from './growth-foundation-module.js';
import { DecisionSimulationService, MemoryDecisionSimulationRepository } from './decision-simulation-service.js';
import { MysqlDecisionSimulationRepository, DECISION_SIMULATION_SCHEMA } from './decision-simulation-mysql-repository.js';
import { createDecisionSimulationRouter } from './decision-simulation-router.js';
import { DecisionPreparationService } from './decision-preparation.js';
import { createDecisionPreparationRouter } from './decision-preparation-router.js';
import { createFinanceDocumentModel } from './finance-document-model.js';
import type { DurableModelRuntimeStore } from './model-providers/runtime.js';
import {DecisionMemoryService} from './decision-memory.js';
import {DECISION_MEMORY_SCHEMA,MemoryDecisionMemoryRepository,MysqlDecisionMemoryRepository} from './decision-memory-repository.js';
import {createDecisionMemoryRouter} from './decision-memory-router.js';
import {AGENT_OPERATING_MEMORY} from './agent-operating-memory.js';

export function createDecisionSimulationModule(options: ({ mode: 'memory' } | { mode: 'mysql'; pool: mysql.Pool }) & {modelStore?:DurableModelRuntimeStore}): GrowthCommercialModule {
  return { name:'decision-simulation', async install({router,privateServices}) {
    const foundation=privateServices.require(GROWTH_FOUNDATION_SERVICES);
    if(options.mode==='mysql') await options.pool.execute(DECISION_SIMULATION_SCHEMA);
    const repository=options.mode==='mysql' ? new MysqlDecisionSimulationRepository(options.pool) : new MemoryDecisionSimulationRepository();
    const service=new DecisionSimulationService(repository);
    if(options.mode==='mysql')await options.pool.execute(DECISION_MEMORY_SCHEMA);
    const memory=new DecisionMemoryService(options.mode==='mysql'?new MysqlDecisionMemoryRepository(options.pool):new MemoryDecisionMemoryRepository(),service);
    privateServices.provide(AGENT_OPERATING_MEMORY,memory);
    router.use('/api/v1/agent-memory/operating',createDecisionMemoryRouter({service:memory,workspaceContext:foundation.workspaceContext}));
    router.use('/api/v1/decision-simulations/memory',createDecisionMemoryRouter({service:memory,workspaceContext:foundation.workspaceContext}));
    const preparations=new DecisionPreparationService({simulations:service,model:options.modelStore?createFinanceDocumentModel(options.modelStore):async()=>{throw new Error('decision_model_unavailable');}});
    router.use('/api/v1/decision-simulations/preparations',createDecisionPreparationRouter({service:preparations,workspaceContext:foundation.workspaceContext}));
    router.use('/api/v1/decision-simulations',createDecisionSimulationRouter({service,workspaceContext:foundation.workspaceContext}));
    return {async close() {preparations.close();}};
  } };
}
