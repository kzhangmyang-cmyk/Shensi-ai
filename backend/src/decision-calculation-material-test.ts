import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionCalculationCells} from './decision-calculation-material.js';
test('agent context distinguishes confirmed assumptions from deterministic cash/profit results',()=>{
  const cells=decisionCalculationCells({runId:'7707614e-521a-479e-9e3d-b8da6d76eab1',title:'合成',dataKind:'synthetic',assumptionNote:'人工假设',baseline:{cashMinor:10000,monthlyOrders:10,backlogUnits:0,capacityUnits:10,priceMinor:1000,unitCostMinor:400,fixedCostMinor:1000,collectionMonths:1,receivables:[],payables:[]},alternatives:[],options:{seed:7,samples:100,months:1,assumptions:{demand:[1,1],procurement:[1,1],delivery:[1,1],collectionDelay:[0,0],persistence:0,commonWeight:0}}});
  assert.ok(cells.some(cell=>cell.sourceRef.startsWith('confirmed:')&&cell.text.includes('期初现金100.00元')));
  assert.ok(cells.some(cell=>cell.sourceRef.startsWith('calc:')&&cell.text.includes('最差月末现金50.00元')&&cell.text.includes('50.00–50.00元')));
  assert.ok(cells.some(cell=>cell.text.includes('条件敏感性')));
  assert.equal(new Set(cells.map(cell=>cell.sourceRef)).size,cells.length);
});
