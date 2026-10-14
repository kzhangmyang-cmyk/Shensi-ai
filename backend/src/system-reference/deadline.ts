import {ReferenceAccessError} from './authority.js';
const deadlines=new WeakMap<AbortSignal,{expires:number;abort:()=>void}>();
/** A monotonic fence supplements timers: synchronous work may defer timer callbacks.
 * This does not preempt native SQL/COMMIT; uncertain outcomes are never retried. */
export function referenceDeadline(timeoutMs:number){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw Error('reference_timeout_invalid');
  const controller=new AbortController();deadlines.set(controller.signal,{expires:performance.now()+timeoutMs,abort:()=>controller.abort()});return controller;
}
export function checkReferenceSignal(signal?:AbortSignal){
  const deadline=signal?deadlines.get(signal):undefined;
  if(deadline&&performance.now()>=deadline.expires)deadline.abort();
  if(signal?.aborted)throw new ReferenceAccessError(503,'reference_cancelled');
}
