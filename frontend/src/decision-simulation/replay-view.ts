import { escapeHtml as e } from '../demo/demo-ui';
import type { SimulationRecord } from './samples';
import { replayFrame, replayScale } from './replay-data';
import { monthFactors, renderReplayExplanation, replayComparison } from './replay-explanation';

const money=(value:number)=>(value/100).toLocaleString('zh-CN',{maximumFractionDigits:2});
const axisMoney=(value:number)=>Math.abs(value)>=1000000?`¥ ${(value/1000000).toLocaleString('zh-CN',{maximumFractionDigits:1})}万`:`¥ ${(value/100).toLocaleString('zh-CN',{maximumFractionDigits:0})}`;
const planName=(id:string)=>id==='baseline'?'维持现状':id;
const playIcon='<i class="ph ph-play" aria-hidden="true"></i>';
const pauseIcon='<i class="ph ph-pause" aria-hidden="true"></i>';

/** Interactive playback is exclusively a view over the saved deterministic report. */
export function mountDecisionReplay(host:HTMLElement, record:SimulationRecord,
  onSelection:(plan:number,sample:number,month:number)=>void=()=>{},retainOnDetach=false) {
  const doc=host.ownerDocument, win=doc.defaultView;
  const plans=record.report.replays;
  if(!plans.length||!plans[0].samples.length||!plans[0].samples[0].months.length){host.textContent='此记录缺少月度路径，无法回放。请返回历史记录选择完整报告。';return ()=>{};}
  const months=plans[0].samples[0].months.length;
  const count=plans[0].samples.length;
  const scale=replayScale(plans,{width:600,height:270});
  const miniScale=replayScale(plans,{width:100,height:24});
  const pathId=`decision-path-${record.runId.replace(/[^a-zA-Z0-9-]/g,'')}`;
  let plan=0,sample=0,month=months-1,comparison=-1,playing=false,disposed=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const paths=plans.map(value=>value.samples.map(value=>value.months.map((item,index)=>`${index?'L':'M'}${scale.x(index,months).toFixed(2)},${scale.y(item.cashMinor).toFixed(2)}`).join(' ')));
  const miniPaths=plans.map(value=>value.samples.map(value=>value.months.map((item,index)=>`${index?'L':'M'}${miniScale.x(index,months).toFixed(2)},${miniScale.y(item.cashMinor).toFixed(2)}`).join(' ')));
  const distinctCounts=plans.map(value=>new Set(value.samples.map(item=>item.months.map(month=>month.cashMinor).join(','))).size);
  const options=plans.map((item,index)=>`<option value="${index}">${e(planName(item.planId))}</option>`).join('');
  host.innerHTML=`<section class="decision-replay" aria-label="条件情景结果回放">
    <div class="decision-replay-main"><div class="decision-plot-panel"><header><div><h3>已完成计算 · 结果回放</h3><p>${count}条条件情景 · 月末现金（元）</p></div><span class="decision-chart-legend">细线：其他情景　粗线：已选中　虚线：零现金</span></header>
      <svg class="decision-path-chart" viewBox="0 0 690 324" role="img" aria-label="所有样本的月末现金路径；详细数值见右侧和月度表格"><defs><clipPath id="${pathId}"><rect data-path-clip width="600" height="270"/></clipPath></defs><g transform="translate(70,15)">
      ${[0,.25,.5,.75,1].map(f=>`<line class="decision-chart-grid" x1="0" x2="600" y1="${f*270}" y2="${f*270}"/><text class="decision-chart-tick" text-anchor="end" x="-10" y="${f*270+4}">${e(axisMoney(scale.maximum-(scale.maximum-scale.minimum)*f))}</text>`).join('')}
      <line class="decision-chart-zero" x1="0" x2="600" y1="${scale.y(0)}" y2="${scale.y(0)}"/>
      <g clip-path="url(#${pathId})"><g data-all-paths></g><path class="decision-selected-path" data-selected-path/><path class="decision-comparison-path" data-comparison-path/></g><circle data-path-point r="5" class="decision-path-point"/>
      ${Array.from({length:months},(_,index)=>index===0||index===months-1||months<=12||index%2===0?`<text class="decision-chart-tick" text-anchor="middle" x="${scale.x(index,months)}" y="300">M${index+1}</text>`:'').join('')}</g></svg>
    </div><div class="decision-world-panel"><h3>选择情景（${count}条）</h3><p>方向键移动，回车选择</p><div class="decision-world-grid" role="group" aria-label="选择模拟情景">${Array.from({length:count},(_,index)=>`<button type="button" data-world="${index}" tabindex="${index===0?0:-1}" aria-pressed="${index===0}">${index+1}</button>`).join('')}</div><p class="decision-world-legend">数字：情景编号　!：当前月现金不足</p><p data-world-count></p></div>
    <aside class="decision-world-inspector"><h3 data-world-title></h3><dl data-world-values></dl><p data-comparison-value></p><p>${record.input.dataKind==='synthetic'?'合成数据，非真实企业结果。':'根据本人填写的经营数据计算。'}样本不是现实成功概率。</p></aside></div>
    <div class="decision-playback-toolbar"><button type="button" data-play>${playIcon}<span>播放</span></button><label class="decision-month-control">月份<input type="range" min="0" max="${months-1}" value="${month}" step="1" data-month><output data-month-label></output></label><label>速度<select data-speed><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select></label><label>方案<select data-plan>${options}</select></label><label>对照<select data-comparison><option value="-1">不对照</option>${options}</select></label><label>情景<select data-sample>${Array.from({length:count},(_,index)=>`<option value="${index}">${index+1}</option>`).join('')}</select></label></div>
    <p role="status" class="decision-playback-status" data-playback-status></p></section>`;
  const root=host.querySelector<HTMLElement>('.decision-replay')!;
  const query=<T extends Element=HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
  const plot=query('.decision-plot-panel'),inspector=query('.decision-world-inspector');
  const cursor=doc.createElementNS('http://www.w3.org/2000/svg','line');cursor.classList.add('decision-month-cursor');cursor.setAttribute('y1','0');cursor.setAttribute('y2','270');query('[data-path-point]').before(cursor);
  const tooltip=doc.createElementNS('http://www.w3.org/2000/svg','title');query('[data-path-point]').append(tooltip);
  const worldPanel=query('.decision-world-panel');
  worldPanel.innerHTML=`<header><h3>${count}个情景，一眼看全</h3><p data-overview-context></p></header><div class="decision-world-grid" role="group" aria-label="全部情景真实现金走势">${Array.from({length:count},(_,index)=>`<button type="button" data-world="${index}" tabindex="${index===0?0:-1}" aria-pressed="${index===0}"><span data-mini-label>${String(index+1).padStart(3,'0')}</span><svg viewBox="-3 -3 106 30" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="100" y1="${miniScale.y(0)}" y2="${miniScale.y(0)}" class="decision-mini-zero"/><path data-mini-path/><circle data-mini-point r="2.5"/></svg></button>`).join('')}</div><p class="decision-world-legend">绿：截至当前月未出现负现金 · 黄：此前负现金，当前已恢复 · 红：当前月现金&lt;0。全格统一比例，圆点标示当前月；不代表发生概率。</p><p data-world-count></p>`;
  query('.decision-replay-main').prepend(worldPanel);
  root.querySelectorAll('[data-world]').forEach(button=>{const summary=doc.createElement('span');summary.dataset.miniFactors='';button.append(summary);});
  const explanation=doc.createElement('section');explanation.className='decision-factor-explanation';explanation.dataset.factorExplanation='';root.append(explanation);
  const currentFactors=doc.createElement('p');currentFactors.dataset.selectedFactors='';inspector.append(currentFactors);
  const switcher=doc.createElement('div');switcher.className='decision-replay-switcher';
  switcher.innerHTML=`<div role="group" aria-label="情景查看方式"><button type="button" data-replay-view-button="overview" aria-pressed="true">${count}情景总览</button><button type="button" data-replay-view-button="detail" aria-pressed="false">单情景回放</button></div>`;root.prepend(switcher);
  const toolbar=query('.decision-playback-toolbar');plot.append(toolbar);
  const selectors=doc.createElement('div');selectors.className='decision-plan-selectors';
  for(const name of ['plan','comparison'])selectors.append(query(`[data-${name}]`).closest('label')!);
  switcher.append(selectors);
  const sampleSelector=query('[data-sample]').closest('label')!;
  sampleSelector.classList.add('decision-inspector-selector');inspector.prepend(sampleSelector);
  const restart=doc.createElement('button');restart.type='button';restart.dataset.restart='';restart.textContent='重播';toolbar.append(restart);
  query('.decision-plot-panel h3').textContent=`${count}条可能的经营轨迹`;
  query('.decision-chart-legend').textContent='细线：全部情景 · 亮线：选中情景 · 虚线：对照方案';
  const plotDescription=plot.querySelector('header p');if(plotDescription)plotDescription.textContent='月末现金（元） · 现金与经营利润分别展示';
  plot.append(query('[data-playback-status]'));
  const setPlaybackText=()=>{query('[data-play]').innerHTML=`${playing?pauseIcon:playIcon}<span>${playing?'暂停':'播放'}</span>`;query('[data-playback-status]').textContent=`${playing?'正在回放':'已暂停'} · M${month+1}/${months} · 情景${sample+1}。数据已经计算完成，播放不会请求模型或重新计算。`;};
  function pause(){playing=false;if(timer!==undefined)clearTimeout(timer);timer=undefined;setPlaybackText();}
  function showReplayView(view:'overview'|'detail'){pause();root.dataset.replayView=view;worldPanel.hidden=view!=='overview';plot.hidden=view!=='detail';root.querySelectorAll<HTMLButtonElement>('[data-replay-view-button]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.replayViewButton===view)));}
  root.querySelectorAll<HTMLButtonElement>('[data-replay-view-button]').forEach(button=>button.onclick=()=>showReplayView(button.dataset.replayViewButton as 'overview'|'detail'));
  function draw(rebuildPaths=false){
    const frame=replayFrame(plans[plan],month,sample);
    if(rebuildPaths)query('[data-all-paths]').innerHTML=paths[plan].map(path=>`<path class="decision-background-path" d="${path}"/>`).join('');
    query('[data-selected-path]').setAttribute('d',paths[plan][sample]);
    query('[data-comparison-path]').setAttribute('d',comparison>=0?paths[comparison][sample]:'');
    const x=scale.x(month,months),y=scale.y(frame.selected.cashMinor);
    cursor.setAttribute('x1',String(x));cursor.setAttribute('x2',String(x));tooltip.textContent=`第${month+1}月 · 情景${sample+1} · 月末现金 ¥${money(frame.selected.cashMinor)}`;
    query('[data-path-clip]').setAttribute('width',String(Math.max(1,x)));
    query('[data-path-point]').setAttribute('transform',`translate(${x},${y})`);
    query('[data-world-title]').textContent=`情景${sample+1} · 第${month+1}月`;
    explanation.innerHTML=renderReplayExplanation(record,plan,sample,month);
    currentFactors.textContent=`本月因素：${monthFactors(frame.selected)?.join('；')??'历史记录未保存'}。经营利润 ¥${money(frame.selected.profitMinor)}。逐月传导见下方解释。`;
    query('[data-world-values]').innerHTML=[['月末现金（元）',money(frame.selected.cashMinor)],['订单 / 交付（件）',`${frame.selected.orders} / ${frame.selected.delivered}`],['待交付积压（件）',String(frame.selected.backlogUnits)],['本月收入（元）',money(frame.selected.revenueMinor)],['本月回款（元）',money(frame.selected.receiptsMinor)],['本月支付（元）',money(frame.selected.paymentsMinor)]].map(([label,value],index)=>`<div><dt>${label}</dt><dd class="${index===0&&frame.selected.cashMinor<0?'decision-negative':''}">${e(value)}</dd></div>`).join('');
    query('[data-comparison-value]').textContent=comparison>=0?replayComparison(record,plan,comparison,sample,month):'选择对照方案，可在同一情景与月份比较。';
    root.querySelectorAll<HTMLButtonElement>('[data-world]').forEach((button,index)=>{const negative=frame.cashValues[index]<0,recovered=!negative&&plans[plan].samples[index].months.slice(0,month).some(item=>item.cashMinor<0);button.classList.toggle('is-gap',negative);button.classList.toggle('is-recovered',recovered);button.setAttribute('aria-pressed',String(index===sample));button.tabIndex=index===sample?0:-1;button.title=`情景${index+1} · M${month+1}现金 ¥${money(frame.cashValues[index])}${negative?' · 当前资金缺口':recovered?' · 曾有资金缺口，当前已恢复':' · 截至当前月无资金缺口'}`;button.setAttribute('aria-label',button.title);if(rebuildPaths)button.querySelector('[data-mini-path]')!.setAttribute('d',miniPaths[plan][index]);button.querySelector('[data-mini-point]')!.setAttribute('cx',String(miniScale.x(month,months)));button.querySelector('[data-mini-point]')!.setAttribute('cy',String(miniScale.y(frame.cashValues[index])));});
    query('[data-overview-context]').textContent=`${planName(plans[plan].planId)} · M${month+1}/${months} · ${count}条已计算路径（${distinctCounts[plan]}条不同现金走势）。选格看右侧数值，切换单情景回放可逐月查看。`;
    query('[data-world-count]').textContent=`当前月资金缺口：${frame.fundingGapCount}/${count}条`;
    root.querySelectorAll<HTMLButtonElement>('[data-world]').forEach((button,index)=>{const factors=monthFactors(plans[plan].samples[index].months[month]);button.querySelector('[data-mini-factors]')!.textContent=factors?.[0]??'因素未保存';button.title+=` · ${factors?.join('，')??'历史因素未保存'}`;button.setAttribute('aria-label',button.title);});
    query<HTMLInputElement>('[data-month]').value=String(month);query('[data-month-label]').textContent=`M${month+1} / ${months}`;
    query<HTMLSelectElement>('[data-sample]').value=String(sample);
    setPlaybackText();onSelection(plan,sample,month);
  }
  const next=()=>{timer=setTimeout(()=>{if(disposed||!root.isConnected||doc.hidden){pause();return;}if(month>=months-1){pause();return;}month++;draw();if(month===months-1)pause();else next();},900/Number(query<HTMLSelectElement>('[data-speed]').value));};
  query<HTMLButtonElement>('[data-play]').onclick=()=>{if(playing){pause();return;}if(month===months-1)month=0;playing=true;draw();next();};
  restart.onclick=()=>{pause();month=0;playing=true;draw();next();};
  query<HTMLInputElement>('[data-month]').oninput=()=>{pause();month=Number(query<HTMLInputElement>('[data-month]').value);draw();};
  query<HTMLSelectElement>('[data-plan]').onchange=()=>{pause();plan=Number(query<HTMLSelectElement>('[data-plan]').value);draw(true);};
  query<HTMLSelectElement>('[data-comparison]').onchange=()=>{comparison=Number(query<HTMLSelectElement>('[data-comparison]').value);draw();};
  query<HTMLSelectElement>('[data-sample]').onchange=()=>{sample=Number(query<HTMLSelectElement>('[data-sample]').value);draw();};
  query<HTMLSelectElement>('[data-speed]').onchange=()=>{if(playing){if(timer!==undefined)clearTimeout(timer);next();}};
  root.querySelectorAll<HTMLButtonElement>('[data-world]').forEach(button=>{
    button.onclick=()=>{sample=Number(button.dataset.world);draw();};
    button.onkeydown=event=>{const offsets:Record<string,number>={ArrowRight:1,ArrowLeft:-1,ArrowDown:10,ArrowUp:-10};let index=Number(button.dataset.world);if(event.key==='Home')index=0;else if(event.key==='End')index=count-1;else if(event.key in offsets)index=Math.max(0,Math.min(count-1,index+offsets[event.key]));else return;event.preventDefault();sample=index;draw();query<HTMLButtonElement>(`[data-world="${index}"]`).focus();};
  });
  const visibility=()=>{if(doc.hidden)pause();};doc.addEventListener('visibilitychange',visibility);
  root.addEventListener('decision-replay-pause',pause);
  const media=win?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const motionChange=()=>{root.classList.toggle('reduce-motion',Boolean(media?.matches));if(media?.matches)pause();};media?.addEventListener('change',motionChange);motionChange();
  const observer=win?.MutationObserver?new win.MutationObserver(()=>{if(!root.isConnected){if(retainOnDetach)pause();else dispose();}}):undefined;
  observer?.observe(doc.body,{childList:true,subtree:true});
  function dispose(){if(disposed)return;disposed=true;if(timer!==undefined)clearTimeout(timer);observer?.disconnect();root.removeEventListener('decision-replay-pause',pause);doc.removeEventListener('visibilitychange',visibility);media?.removeEventListener('change',motionChange);}
  draw(true);showReplayView('overview');return dispose;
}
