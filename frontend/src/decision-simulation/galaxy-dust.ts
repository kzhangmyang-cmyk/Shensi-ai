/** Decorative particles only: no preparation, model, progress or business inputs. */
export function createGalaxyDust(count=4400) {
  let seed=17;
  const random=()=>{seed=(seed*16807)%2147483647;return(seed-1)/2147483646;};
  return Array.from({length:count},(_,index)=>{const radius=.06+Math.pow(random(),.65)*.94,layer=index%3;return {
    radius,arm:Math.floor(random()*5),spread:(random()-.5)*(.3+layer*.18),phase:random()*Math.PI*2,
    size:.2+layer*.18+random()*.45,alpha:.08+layer*.07+random()*.3,speed:(.07+.12*(1-radius))*(.75+layer*.25),
  };});
}
type Dust=ReturnType<typeof createGalaxyDust>[number];
export function galaxyDustPosition(dust:Dust,time:number,width:number,height:number) {
  const radius=Math.min(width*.25,height*.33),tilt=-.08;
  const theta=dust.arm*Math.PI*2/5+dust.radius*7.2+dust.spread+time*dust.speed;
  const x=Math.cos(theta)*dust.radius*radius,y=Math.sin(theta)*dust.radius*radius*.95;
  return {x:width*.5+x*Math.cos(tilt)-y*Math.sin(tilt),y:height*.5+x*Math.sin(tilt)+y*Math.cos(tilt)};
}

export function mountGalaxyDust(canvas:HTMLCanvasElement,asset?:HTMLImageElement) {
  const win=canvas.ownerDocument.defaultView,context=canvas.getContext?.('2d');
  if(!win||!context||!win.requestAnimationFrame)return {setRunning(_value:boolean){},dispose(){}};
  let particles=createGalaxyDust();
  let frame:number|undefined,last:number|undefined,paintedAt:number|undefined,time=0,width=0,height=0,running=false,disposed=false;
  function draw(){
    context!.clearRect(0,0,width,height);
    const canvasBox=canvas.getBoundingClientRect(),area=asset?.parentElement?.getBoundingClientRect();
    const aw=area?.width??width,ah=area?.height??height,ax=area?area.left-canvasBox.left:0,ay=area?area.top-canvasBox.top:0;
    // Sparse, low-luminance stars bridge the artwork and the full stage, including its margins.
    for(let i=0;i<180;i++){
      context!.globalAlpha=.06+.12*(1+Math.sin(time*.3+i))/2;context!.fillStyle='#a9dce8';
      context!.beginPath();context!.arc(((i*.61803398875)%1)*width,((i*.754877666)%1)*height,.35+(i%3)*.15,0,Math.PI*2);context!.fill();
    }
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
    if(paintedAt===undefined||now-paintedAt>=1000/30){draw();paintedAt=now;}
    frame=win!.requestAnimationFrame(tick);
  }
  const observer=win.ResizeObserver?new win.ResizeObserver(resize):undefined;
  observer?.observe(canvas);if(!observer)win.addEventListener('resize',resize);resize();
  return {
    setRunning(value:boolean){if(disposed||running===value)return;running=value;last=undefined;paintedAt=undefined;
      if(frame!==undefined){win.cancelAnimationFrame(frame);frame=undefined;}
      if(running)frame=win.requestAnimationFrame(tick);
    },
    dispose(){disposed=true;running=false;if(frame!==undefined)win.cancelAnimationFrame(frame);frame=undefined;observer?.disconnect();win.removeEventListener('resize',resize);},
  };
}
