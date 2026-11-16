import {fitCalibration} from "@workspace/domain/calibration";
import {PROSPECTIVE_METHOD,type ProspectivePlan,type Receipt} from "../prospectiveEvaluation.js";
export const REGISTERED="2030-01-01T00:00:00.000Z";
export function fixturePlan():ProspectivePlan {
 const model=(version:number,wins:number)=>({fitKey:"eleanor|EURUSD|M15",version,fittedAt:"2029-12-31T00:00:00Z",dataTo:"2029-12-30T00:00:00Z",
 fit:fitCalibration(Array.from({length:100},(_,i)=>({score:50,outcome:i<wins?1 as const:0 as const})))});
 return {method:PROSPECTIVE_METHOD,userId:42,strategy:"eleanor",symbol:"EURUSD",timeframe:"M15",collectionStart:"2030-01-02T00:00:00Z",collectionEnd:"2030-01-03T00:00:00Z",labelDeadline:"2030-01-04T00:00:00Z",minSample:100,minImprovement:0.005,candidate:model(2,90),baseline:model(1,50)};
}
export function fixtureReceipts(plan=fixturePlan()):Receipt[] {
 const start=Date.parse(plan.collectionStart),width=Date.parse(plan.collectionEnd)-start;
 return Array.from({length:100},(_,i)=>{
 const at=new Date(start+(i+0.5)*width/100).toISOString(),resolved=new Date(Date.parse(at)+1000).toISOString();
 return [{outcomeId:`outcome-${i}`,phase:"prediction",observedAt:at,payload:{user_id:plan.userId,symbol:plan.symbol,timeframe:plan.timeframe,direction:"BUY",confidence_score:50,locked:true,locked_at:at,created_at:at,outcome_status:"PENDING",resolved_at:null}},
 {outcomeId:`outcome-${i}`,phase:"outcome",observedAt:resolved,payload:{outcome_status:"WIN",resolved_at:resolved,evidence:{method:"observed_move",favorableMovePct:1,adverseMovePct:0}}}];
 }).flat();
}
