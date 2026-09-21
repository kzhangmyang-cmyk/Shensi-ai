import test from 'node:test';
import assert from 'node:assert/strict';
import {homeParticle,radarPosition,HOME_MAX_DPR} from './motion';
test('home effects remain bounded and deterministic without business data',()=>{
 assert.equal(HOME_MAX_DPR,1.5);
 for(const kind of ['acquisition','agents','decision-simulation'])for(let i=0;i<32;i++)for(const t of [0,5,500]){
  const p=homeParticle(kind,i,t);assert.deepEqual(p,homeParticle(kind,i,t));
  assert.ok(p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1&&p.alpha>=0&&p.alpha<=1);
 }
 assert.notDeepEqual(homeParticle('acquisition',3,0),homeParticle('acquisition',3,4));
});
test('radar stays on its glass plane and collaboration has six distinct paths',()=>{
 assert.deepEqual(radarPosition(2,0),{x:.49,y:.36});
 for(let angle=0;angle<Math.PI*2;angle+=.1){const p=radarPosition(angle,1);assert.ok(p.x>0&&p.x<1&&p.y>0&&p.y<.75);}
 assert.equal(new Set(Array.from({length:6},(_,i)=>JSON.stringify(homeParticle('agents',i,2)))).size,6);
 assert.deepEqual(homeParticle('decision-simulation',0,0),{x:.6,y:.36,z:0,alpha:.55});
});
