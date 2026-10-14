/** Decorative particles only: no preparation, model, progress or business inputs. */
export function createGalaxyDust(count=4400) {
  let seed=17;
  const random=()=>{seed=(seed*16807)%2147483647;return(seed-1)/2147483646;};
  return Array.from({length:count},(_,index)=>{const radius=.06+Math.pow(random(),.65)*.94,layer=index%3;return {
    radius,arm:Math.floor(random()*3),spread:(random()-.5)*(.3+layer*.18),phase:random()*Math.PI*2,
    size:.2+layer*.18+random()*.45,alpha:.08+layer*.07+random()*.3,speed:(.07+.12*(1-radius))*(.75+layer*.25),
  };});
}
type Dust=ReturnType<typeof createGalaxyDust>[number];
export function galaxyDustPosition(dust:Dust,time:number,width:number,height:number) {
  const radius=Math.min(width*.25,height*.33),tilt=-.08;
  const theta=dust.arm*Math.PI*2/3+dust.radius*7.2+dust.spread+time*dust.speed*.3;
  const x=Math.cos(theta)*dust.radius*radius,y=Math.sin(theta)*dust.radius*radius*.95;
  return {x:width*.5+x*Math.cos(tilt)-y*Math.sin(tilt),y:height*.5+x*Math.sin(tilt)+y*Math.cos(tilt)};
}

export function mountGalaxyDust(canvas:HTMLCanvasElement,asset?:HTMLImageElement) {
  const win=canvas.ownerDocument.defaultView,context=canvas.getContext?.('2d');
  if(!win||!context||!win.requestAnimationFrame)return {setRunning(_value:boolean){},dispose(){}};
  let particles=createGalaxyDust();
  let frame:number|undefined,last:number|undefined,paintedAt:number|undefined,time=0,width=0,height=0,running=false,disposed=false;
  const surface=canvas.parentElement;
  let targetX=0,targetY=0,offsetX=0,offsetY=0;
  const pointer=(event:PointerEvent)=>{if(!running||width<700||event.pointerType==='touch')return;const box=canvas.getBoundingClientRect();targetX=Math.max(-6,Math.min(6,(event.clientX-box.left-width/2)/width*12));targetY=Math.max(-4,Math.min(4,(event.clientY-box.top-height/2)/height*8));};
  const resetPointer=()=>{targetX=0;targetY=0;};
  surface?.addEventListener('pointermove',pointer);surface?.addEventListener('pointerleave',resetPointer);
  function draw(){
    context!.clearRect(0,0,width,height);
    context!.save();context!.translate(offsetX,offsetY);
    const canvasBox=canvas.getBoundingClientRect(),area=asset?.parentElement?.getBoundingClientRect();
    const aw=area?.width??width,ah=area?.height??height,ax=area?area.left-canvasBox.left:0,ay=area?area.top-canvasBox.top:0;
    // Sparse, low-luminance stars bridge the artwork and the full stage, including its margins.
    for(let i=0;i<180;i++){
      context!.globalAlpha=.06+.12*(1+Math.sin(time*.3+i))/2;context!.fillStyle='#a9dce8';
      const depth=1+i%3;
      context!.beginPath();context!.arc(((i*.61803398875)%1)*width+Math.sin(time*.07+i)*depth*2,((i*.754877666)%1)*height+Math.cos(time*.06+i)*depth*1.5,.35+(i%3)*.15,0,Math.PI*2);context!.fill();
    }
    // Low-amplitude core breathing and three sparse orbit lights; the raster and labels stay fixed.
    for(let ring=10;ring>0;ring--){context!.globalAlpha=.004+.002*(1+Math.sin(time*.55))/2;context!.fillStyle='#b9efff';context!.beginPath();context!.arc(ax+aw*.5,ay+ah*.5,ring*3*(1+.015*Math.sin(time*.55)),0,Math.PI*2);context!.fill();}
    for(let arm=0;arm<3;arm++){const point=galaxyDustPosition({radius:.65,arm,spread:0,phase:0,size:1,alpha:.2,speed:.08},time,aw,ah);context!.globalAlpha=.22;context!.fillStyle='#d0f7ff';context!.beginPath();context!.arc(ax+point.x,ay+point.y,1.5,0,Math.PI*2);context!.fill();}
    for(const dust of particles){const point=galaxyDustPosition(dust,time,aw,ah);
      context!.globalAlpha=dust.alpha*(.75+.25*Math.sin(time*.7+dust.phase));
      context!.fillStyle=dust.radius<.24?'#efffff':'#83ecff';context!.beginPath();context!.arc(ax+point.x,ay+point.y,dust.size,0,Math.PI*2);context!.fill();
    }
    // Re-light only the three existing raster orbs. Their positions never orbit.
    if(asset?.complete&&asset.naturalWidth){
      const scale=Math.min(aw/asset.naturalWidth,ah/asset.naturalHeight);
      const w=asset.naturalWidth*scale,h=asset.naturalHeight*scale,left=ax+(aw-w)/2,top=ay+(ah-h)/2;
      for(const [index,[x,y]] of [[.5,.12],[.2,.736],[.798,.736]].entries()){
        context!.save();context!.beginPath();context!.arc(left+x*w,top+y*h,w*.075,0,Math.PI*2);context!.clip();
        context!.globalAlpha=.10+.10*(1+Math.sin(time*1.7+index*2.1))/2;
        context!.drawImage(asset,left,top,w,h);context!.restore();
      }
    }
    context!.globalAlpha=1;
    context!.restore();
  }
  function resize(){
    if(disposed)return;const box=canvas.getBoundingClientRect();width=box.width;height=box.height;
    const count=width<600?2200:4400;if(particles.length!==count)particles=createGalaxyDust(count);
    const ratio=Math.min(win!.devicePixelRatio||1,2);canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
    context!.setTransform(ratio,0,0,ratio,0,0);draw();
  }
  function tick(now:number){
    frame=undefined;if(!running||disposed)return;
    if(last!==undefined)time+=Math.min((now-last)/1000,.05);last=now;
    // 30fps paint cap; resuming starts from the same angle without a time jump.
    if(paintedAt===undefined||now-paintedAt>=1000/30){offsetX+=(targetX-offsetX)*.06;offsetY+=(targetY-offsetY)*.06;draw();paintedAt=now;}
    frame=win!.requestAnimationFrame(tick);
  }
  const observer=win.ResizeObserver?new win.ResizeObserver(resize):undefined;
  observer?.observe(canvas);if(!observer)win.addEventListener('resize',resize);resize();
  return {
    setRunning(value:boolean){if(disposed||running===value)return;running=value;last=undefined;paintedAt=undefined;
      if(frame!==undefined){win.cancelAnimationFrame(frame);frame=undefined;}
      if(running)frame=win.requestAnimationFrame(tick);
    },
    dispose(){disposed=true;running=false;if(frame!==undefined)win.cancelAnimationFrame(frame);frame=undefined;observer?.disconnect();win.removeEventListener('resize',resize);surface?.removeEventListener('pointermove',pointer);surface?.removeEventListener('pointerleave',resetPointer);},
  };
}
