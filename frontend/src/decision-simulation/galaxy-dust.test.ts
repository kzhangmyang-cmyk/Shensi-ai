import assert from 'node:assert/strict';
import test from 'node:test';
import {createGalaxyDust,galaxyDustPosition,mountGalaxyDust} from './galaxy-dust';
import {parseHTML} from 'linkedom';

test('internal spiral dust is bounded, deterministic and differential; the image need not rotate',()=>{
  const dust=createGalaxyDust();assert.equal(dust.length,4400);assert.equal(createGalaxyDust(2200).length,2200);assert.deepEqual(dust,createGalaxyDust());
  const sameLayer=dust.filter((_,index)=>index%3===0);
  const inner=sameLayer.reduce((a,b)=>a.radius<b.radius?a:b),outer=sameLayer.reduce((a,b)=>a.radius>b.radius?a:b);assert.ok(inner.speed>outer.speed);
  assert.notDeepEqual(galaxyDustPosition(outer,0,700,480),galaxyDustPosition(outer,3,700,480));
  for(const particle of dust){const p=galaxyDustPosition(particle,20,700,480);assert.ok(p.x>=0&&p.x<=700&&p.y>=0&&p.y<=480);}
});

test('dust cancels frames on pause/disposal and does not accumulate background time',()=>{
  const {document,window}=parseHTML('<html><body><canvas></canvas></body></html>');
  const canvas=document.querySelector('canvas')!;let next=0,arcs=0,lights=0,disconnected=false;
  const callbacks=new Map<number,FrameRequestCallback>();
  window.requestAnimationFrame=(callback)=>{callbacks.set(++next,callback);return next;};
  window.cancelAnimationFrame=(id)=>{callbacks.delete(id);};
  Object.defineProperty(window,'ResizeObserver',{configurable:true,value:class{observe(){}disconnect(){disconnected=true;}}});
  Object.defineProperty(canvas,'getContext',{value:()=>({clearRect(){},setTransform(){},beginPath(){},arc(){arcs++;},fill(){},save(){},restore(){},clip(){},drawImage(){lights++;},globalAlpha:1,fillStyle:''})});
  const asset=document.createElement('img');Object.defineProperties(asset,{complete:{value:true},naturalWidth:{value:1448},naturalHeight:{value:1086}});
  const control=mountGalaxyDust(canvas,asset);assert.equal(callbacks.size,0);assert.equal(lights,3);
  control.setRunning(true);assert.equal(callbacks.size,1);
  const first=callbacks.values().next().value!;callbacks.clear();first(0);assert.equal(callbacks.size,1);assert.ok(arcs>=1800);
  control.setRunning(false);assert.equal(callbacks.size,0);const paused=arcs,pausedLights=lights;control.setRunning(false);assert.equal(arcs,paused);assert.equal(lights,pausedLights);
  control.setRunning(true);assert.equal(callbacks.size,1);control.dispose();assert.equal(callbacks.size,0);assert.equal(disconnected,true);
  control.setRunning(true);assert.equal(callbacks.size,0);
});
