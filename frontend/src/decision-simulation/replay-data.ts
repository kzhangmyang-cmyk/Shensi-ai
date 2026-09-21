import type { components } from '../generated/decision-simulation';

type Replay = components['schemas']['Report']['replays'][number];

/** A frame is a view of persisted calculation results, never a new simulation. */
export function replayFrame(plan:Replay, monthIndex:number, sampleIndex:number) {
  if(!Number.isInteger(sampleIndex)||!plan.samples[sampleIndex])throw new RangeError('Invalid sample index');
  if(!Number.isInteger(monthIndex)||!plan.samples[sampleIndex].months[monthIndex])throw new RangeError('Invalid month index');
  const cashValues=plan.samples.map(sample=>{
    const month=sample.months[monthIndex];
    if(!month)throw new RangeError('Missing month in stored sample');
    return month.cashMinor;
  });
  return {selected:plan.samples[sampleIndex].months[monthIndex],cashValues,fundingGapCount:cashValues.filter(cash=>cash<0).length};
}

/** Keep every plan and time step on one scale so changing selections cannot distort comparisons. */
export function replayScale(plans:Replay[], size:{width:number;height:number}) {
  let minimum=0,maximum=0;
  for(const plan of plans)for(const sample of plan.samples)for(const month of sample.months){minimum=Math.min(minimum,month.cashMinor);maximum=Math.max(maximum,month.cashMinor);}
  const padding=Math.max((maximum-minimum)*0.08,1);
  minimum-=padding;maximum+=padding;
  return {minimum,maximum,y:(value:number)=>size.height-(value-minimum)/(maximum-minimum)*size.height,x:(index:number,count:number)=>count<=1?0:index/(count-1)*size.width};
}
