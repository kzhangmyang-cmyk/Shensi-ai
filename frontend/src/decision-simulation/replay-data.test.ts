import assert from 'node:assert/strict';
import test from 'node:test';
import { replayFrame, replayScale } from './replay-data';
import type { components } from '../generated/decision-simulation';

type Replay = components['schemas']['Report']['replays'][number];
const month = (cashMinor:number, index:number):components['schemas']['Month'] => ({month:index,cashMinor,orders:10,delivered:8,backlogUnits:2,revenueMinor:80,receiptsMinor:70,paymentsMinor:60,profitMinor:20,receivablesMinor:10,shock:{demand:1,procurement:1,collectionDelay:0,delivery:1}});
const plan:Replay = {planId:'baseline',modelVersion:'test',samples:[{months:[month(100,1),month(-50,2)],minimumCashMinor:-50,totalProfitMinor:40,fundingGapMinor:50},{months:[month(300,1),month(200,2)],minimumCashMinor:200,totalProfitMinor:40,fundingGapMinor:0}]};

test('world replay uses stored monthly data, not synthetic interpolation or aggregate outcomes',()=>{
  const first=replayFrame(plan,0,0);
  assert.equal(first.selected.cashMinor,100);
  assert.equal(first.fundingGapCount,0,'future funding gaps are not shown early');
  assert.deepEqual(first.cashValues,[100,300]);
  assert.equal(replayFrame(plan,1,0).fundingGapCount,1);
  assert.equal(replayFrame(plan,1,1).selected.cashMinor,200);
  assert.equal(plan.samples[0].months[0].cashMinor,100,'input is immutable');
});

test('one stable chart scale spans every plan/month and always includes zero',()=>{
  const scale=replayScale([plan],{width:600,height:280});
  assert.ok(scale.y(-50)>scale.y(300));
  assert.ok(scale.y(0)>0&&scale.y(0)<280);
  assert.equal(scale.x(0,2),0);
  assert.equal(scale.x(1,2),600);
  const flat=replayScale([{...plan,samples:[{...plan.samples[0],months:[month(0,1)]}]}],{width:600,height:280});
  assert.ok(Number.isFinite(flat.y(0)));
  assert.equal(flat.x(0,1),0);
});

test('invalid replay indices never silently choose a different world',()=>{
  assert.throws(()=>replayFrame(plan,2,0),/month/);
  assert.throws(()=>replayFrame(plan,0,2),/sample/);
});
