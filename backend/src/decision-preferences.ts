export interface DecisionPreferences {
  priority:'cash'|'profit'|'delivery';cashFloorMinor?:number;pilotFirst:boolean;
  reviewCadence:'weekly'|'monthly';learningEnabled:boolean;confirmedFrom:'self_report'|'explicit_feedback';
}
interface Plan {planId:string;worstMinimumCashMinor:number;profitRangeMinor:number[];maximumBacklogUnits:number}
export function assessDecisionPreferences(preferences:DecisionPreferences,plans:Plan[]){
  const ordered=[...plans].sort((a,b)=>preferences.priority==='cash'?b.worstMinimumCashMinor-a.worstMinimumCashMinor:preferences.priority==='profit'?a.profitRangeMinor[0]===b.profitRangeMinor[0]?0:b.profitRangeMinor[0]-a.profitRangeMinor[0]:a.maximumBacklogUnits-b.maximumBacklogUnits);
  return {priority:preferences.priority,plans:ordered.map(plan=>({planId:plan.planId,meetsCashFloor:preferences.cashFloorMinor===undefined?null:plan.worstMinimumCashMinor>=preferences.cashFloorMinor})),basis:preferences.priority==='cash'?'按样本最差现金由高到低':'profit'===preferences.priority?'按样本最低累计经营利润由高到低':'按样本最大积压由低到高'};
}
