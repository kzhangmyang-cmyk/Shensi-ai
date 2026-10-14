export const HOME_MAX_DPR=1.5;
const collaborationPaths=[
 [.41,.23,.48,.30,.48,.38],[.59,.23,.53,.30,.53,.38],
 [.31,.375,.38,.40,.39,.51],[.71,.375,.64,.42,.64,.53],
 [.24,.585,.31,.49,.38,.52],[.78,.585,.70,.49,.64,.52],
];
export function radarPosition(angle:number,radius:number){
 const x=Math.cos(angle)*.44*radius,y=Math.sin(angle)*.30*radius;
 return {x:.49+x*Math.cos(.35)-y*Math.sin(.35),y:.36+x*Math.sin(.35)+y*Math.cos(.35)};
}
export function homeParticle(kind:string,index:number,time:number){
 const phase=(time*.08+index*.137)%1;
 if(kind==='acquisition'){
  const angle=time*.35+(index%4)*.05;const p=radarPosition(angle,.1+phase*.85);
  return {...p,z:Math.sin(angle),alpha:Math.sin(phase*Math.PI)*.7};
 }
 if(kind==='agents'){
  const [x0,y0,cx,cy,x1,y1]=collaborationPaths[index%6];const t=phase,u=1-t;
  return {x:u*u*x0+2*u*t*cx+t*t*x1,y:u*u*y0+2*u*t*cy+t*t*y1,z:Math.sin(t*Math.PI),alpha:Math.sin(t*Math.PI)*.9};
 }
 const angle=index*2.399+time*.19;const radius=.10+(index%5)*.037;const z=Math.sin(angle);
 return {x:.5+Math.cos(angle)*radius,y:.36+Math.sin(angle)*radius*.54,z,alpha:.35+(z+1)*.2};
}
/** Raster sculpture + projected particles; no WebGL, meshes or imported engine. */
export function installHomeMotion(doc:Document){
 const win=doc.defaultView;
 if(!win?.customElements||!win.IntersectionObserver||!win.ResizeObserver||win.customElements.get('shensi-home-art'))return;
 win.customElements.define('shensi-home-art',class extends win.HTMLElement{
  static get observedAttributes(){return ['data-paused'];}
  private stop?:()=>void;
  private refresh?:()=>void;
  attributeChangedCallback(){this.refresh?.();}
  connectedCallback(){
   this.stop?.();
   // Parser creates this element before its children, so defer one microtask.
   win.queueMicrotask(()=>{
    if(!this.isConnected)return;
    const canvas=this.querySelector('canvas');if(!canvas)return;
    const ctx=canvas.getContext('2d');if(!ctx)return;
    let visible=false,frame=0,last=0,width=0,height=0,elapsed=0,previous=0;
    const reduced=win.matchMedia('(prefers-reduced-motion: reduce)');
    const compact=win.matchMedia('(max-width: 650px)');
    const allowed=()=>visible&&!doc.hidden&&this.dataset.paused!=='true'&&!reduced.matches&&!compact.matches&&(win.navigator.hardwareConcurrency||4)>2;
    const draw=(now:number)=>{
     frame=0;if(!allowed())return;
     if(now-last>=1000/30){
      elapsed+=previous?Math.min((now-previous)/1000,.1):0;previous=now;last=now;
      ctx.clearRect(0,0,width,height);
      if(this.dataset.kind==='acquisition'){
       // Only the projected scanner light moves; the glass and camera stay fixed.
       ctx.save();ctx.globalAlpha=1;ctx.translate(width*.49,height*.36);ctx.rotate(.35);ctx.scale(width*.44,height*.30);
       const angle=elapsed*.35;const glow=ctx.createRadialGradient(0,0,.04,0,0,1);
       glow.addColorStop(0,'#8fffe508');glow.addColorStop(.72,'#8fffe524');glow.addColorStop(1,'#8fffe538');
       ctx.fillStyle=glow;ctx.beginPath();ctx.moveTo(0,0);ctx.arc(0,0,1,angle-.34,angle);ctx.closePath();ctx.fill();ctx.restore();
       const nodes=[[.28,.433],[.477,.574],[.73,.556]];
       nodes.forEach(([x,y],index)=>{
        const pulse=Math.pow(Math.max(0,Math.sin(elapsed*1.1-index*2.1)),4);
        ctx.globalAlpha=.1+pulse*.65;ctx.strokeStyle='#acffea';ctx.lineWidth=1+pulse;
        ctx.beginPath();ctx.ellipse(x*width,y*height,width*.06,height*.019,0,0,Math.PI*2);ctx.stroke();
       });
      }
      for(let i=0;i<32;i++){
       const p=homeParticle(this.dataset.kind??'',i,elapsed);
       ctx.globalAlpha=p.alpha;ctx.fillStyle=this.dataset.kind==='decision-simulation'?'#b8f5ff':i%4===0?'#e5d3a5':'#8deacb';
       ctx.beginPath();ctx.arc(p.x*width,p.y*height,Math.max(.6,(1.05+p.z*.3)*width/360),0,Math.PI*2);ctx.fill();
      }
     }
     frame=win.requestAnimationFrame(draw);
    };
    const update=()=>{
     if(frame)win.cancelAnimationFrame(frame);frame=0;previous=0;
     this.dataset.motion=allowed()?'on':'off';
     if(allowed())frame=win.requestAnimationFrame(draw);else ctx.clearRect(0,0,width,height);
    };
    this.refresh=update;
    const resize=new win.ResizeObserver(()=>{
     const rect=this.getBoundingClientRect();width=rect.width;height=rect.height;
     const dpr=Math.min(win.devicePixelRatio||1,HOME_MAX_DPR);
     canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);update();
    });
    const observer=new win.IntersectionObserver(entries=>{visible=entries.some(entry=>entry.isIntersecting);update();},{threshold:.15});
    resize.observe(this);observer.observe(this);doc.addEventListener('visibilitychange',update);reduced.addEventListener('change',update);compact.addEventListener('change',update);
    this.stop=()=>{if(frame)win.cancelAnimationFrame(frame);observer.disconnect();resize.disconnect();doc.removeEventListener('visibilitychange',update);reduced.removeEventListener('change',update);compact.removeEventListener('change',update);canvas.width=0;canvas.height=0;this.dataset.motion='off';};
   });
  }
  disconnectedCallback(){this.stop?.();this.stop=undefined;this.refresh=undefined;}
 });
}
