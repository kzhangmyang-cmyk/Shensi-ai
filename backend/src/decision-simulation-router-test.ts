import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createDecisionSimulationRouter } from './decision-simulation-router.js';
import { DecisionSimulationService, MemoryDecisionSimulationRepository } from './decision-simulation-service.js';
import { GrowthCommercialRuntimeBridge } from './growth-commercial-runtime-bridge.js';
test('main runtime bridge reserves the new API before startup', async () => {
  const app=express(); app.use(new GrowthCommercialRuntimeBridge().middleware());
  const server=app.listen(0); await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address(); assert.ok(address&&typeof address!=='string');
  try { assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/v1/decision-simulations`)).status,503); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
test('HTTP generation and read stay isolated; request errors never become fake reports', async () => {
  const app = express(); app.use(express.json());
  app.use((req,res,next) => { if (!req.header('x-test-actor')) { res.sendStatus(401); return; } next(); });
  app.use('/api/v1/decision-simulations', createDecisionSimulationRouter({ service: new DecisionSimulationService(new MemoryDecisionSimulationRepository()), workspaceContext: (req: express.Request) => ({ workspaceId: 'isolated', actorId: req.header('x-test-actor')! }) }));
  const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1/decision-simulations`;
  try {
    assert.equal((await fetch(base)).status,401);
    assert.equal((await fetch(base,{headers:{'x-test-actor':'one'}})).status,200);
    const invalid = await fetch(base,{method:'POST',headers:{'x-test-actor':'one','Content-Type':'application/json'},body:'{}'});
    assert.equal(invalid.status,422);
    const missing = await fetch(base+'/7707614e-521a-479e-9e3d-b8da6d76eab1',{headers:{'x-test-actor':'other'}});
    assert.equal(missing.status,404);
    assert.equal((await missing.json()).code,'decision_simulation_not_found');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(()=>resolve())); }
});
