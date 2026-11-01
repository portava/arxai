import { atr, round } from "@workspace/domain/chart-patterns";
import type { DetectedPattern } from "@workspace/domain/market";
import type { SmartChartAnalysisBar, SmartChartFinding } from "./smartChartAnalysis";

/** Bind the shared detector's frozen formation and claimed events to this exact
 * closed-bar window. This validates evidence; it does not discover new flags. */
export function smartChartFlagFinding(raw: DetectedPattern, bars: SmartChartAnalysisBar[], note: string): SmartChartFinding | null {
  const life = raw.flagLifecycle;
  const index = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < bars.length;
  const positive = (n: number) => Number.isFinite(n) && n > 0;
  const same = (a: number, b: number, operandScale=0) => Math.abs(a-b) <= Number.EPSILON * 128 * Math.max(operandScale,Math.abs(a),Math.abs(b));
  if (!life || life.version !== "causal-flag-v1" || ![life.poleStartIndex,life.poleEndIndex,life.flagStartIndex,life.formationKnownAtIndex,life.levelAtIndex].every(index)
    || life.poleEndIndex !== life.poleStartIndex+7 || life.flagStartIndex !== life.poleEndIndex+1 || life.formationKnownAtIndex !== life.flagStartIndex+5
    || life.formationKnownAtIndex < 19 || !Number.isFinite(life.channelSlope)
    || ![life.upperAtStart,life.lowerAtStart,life.frozenAtr,life.confirmationLevel,life.invalidationLevel].every(positive)
    || (life.targetLevel!==null&&!positive(life.targetLevel))
    || life.upperAtStart <= life.lowerAtStart
    || [life.confirmedIndex,life.failedIndex,life.targetReachedIndex].some(n=>n!=null&&(!index(n)||n<=life.formationKnownAtIndex))) return null;
  const bullish=raw.id==="bull_flag",poleStart=bars[life.poleStartIndex]!,poleEnd=bars[life.poleEndIndex]!,last=bars.at(-1)!;
  const poleMove=poleEnd.close-poleStart.close;
  if (bullish ? poleMove<=0||life.channelSlope>0 : poleMove>=0||life.channelSlope<0) return null;
  const formation=bars.slice(life.flagStartIndex,life.formationKnownAtIndex+1);
  // Same six observed closes, independently expressed least-squares sum.
  // Center price as well as index: raw-price cancellation at large synthetic
  // instrument scales can otherwise reject valid source-matched evidence.
  const slope=formation.reduce((sum,b,i)=>sum+(i-2.5)*(b.close-formation[0]!.close),0)/17.5;
  const upper=Math.max(...formation.map((b,i)=>b.high-slope*i));
  const lower=Math.min(...formation.map((b,i)=>b.low-slope*i));
  const volatility=atr(bars.slice(life.formationKnownAtIndex-14,life.formationKnownAtIndex+1),14);
  const centeredRange=Math.max(...formation.map(b=>Math.abs(b.close-formation[0]!.close)));
  if (!same(slope,life.channelSlope,centeredRange)||!same(upper,life.upperAtStart)||!same(lower,life.lowerAtStart)||volatility==null||!same(volatility,life.frozenAtr)) return null;
  const boundary=(at:number,top:boolean)=>(top?life.upperAtStart:life.lowerAtStart)+life.channelSlope*(at-life.flagStartIndex);
  let confirmed:number|null=null,failed:number|null=null,reached:number|null=null;
  for(let i=life.formationKnownAtIndex+1;i<bars.length;i++){
    const close=bars[i]!.close,prior=bars[i-1]!.close;
    const invalidation=boundary(confirmed??i,!bullish);
    if(bullish?close<invalidation:close>invalidation){failed=i;break;}
    if(confirmed==null&&(bullish?prior<=boundary(i-1,true)&&close>boundary(i,true):prior>=boundary(i-1,false)&&close<boundary(i,false)))confirmed=i;
    if(confirmed!=null&&reached==null){
      const target=boundary(confirmed,bullish)+poleMove;
      if(positive(target)&&(bullish?close>=target:close<=target))reached=i;
    }
  }
  const at=confirmed??failed??bars.length-1;
  const trigger=boundary(at,bullish),invalidation=boundary(at,!bullish),projection=trigger+poleMove,target=positive(projection)?projection:null;
  const expectedStatus=failed!=null?"invalidated":reached!=null?"exhausted":confirmed!=null?"confirmed":"forming";
  if(life.confirmedIndex!==confirmed||life.failedIndex!==failed||life.targetReachedIndex!==reached||life.levelAtIndex!==at||raw.status!==expectedStatus
    ||!same(life.confirmationLevel,trigger)||!same(life.invalidationLevel,invalidation)||(target===null?life.targetLevel!==null:life.targetLevel===null||!same(life.targetLevel,target)))return null;
  const knownClose=bars[life.formationKnownAtIndex]!.close,decimals=knownClose>=1000?1:knownClose>=100?2:knownClose>=1?4:5;
  const expected=[{index:life.poleStartIndex,role:"flagpole_start"},{index:life.poleEndIndex,role:"flagpole_end"},{index:life.flagStartIndex,role:"flag_start"},{index:life.formationKnownAtIndex,role:"flag_end"},
    ...(confirmed!=null?[{index:confirmed,role:"flag_break"}]:[]),...(failed!=null?[{index:failed,role:"flag_failure"}]:[])];
  if(raw.keyPoints.length!==expected.length||raw.keyPoints.some((p,i)=>p.index!==expected[i]!.index||p.role!==expected[i]!.role||p.price!==round(bars[p.index]!.close,decimals))
    ||raw.levels.confirmation!==round(trigger,decimals)||raw.levels.invalidation!==round(invalidation,decimals)
    ||(target===null?raw.levels.targets.length!==0:raw.levels.targets.length!==1||raw.levels.targets[0]!==round(target,decimals)))return null;
  const point=(at:number,price:number)=>({time:bars[at]!.time,price});
  const segments=[{from:point(life.poleStartIndex,poleStart.close),to:point(life.poleEndIndex,poleEnd.close)},
    {from:point(life.flagStartIndex,life.upperAtStart),to:point(at,boundary(at,true))},
    {from:point(life.flagStartIndex,life.lowerAtStart),to:point(at,boundary(at,false))}];
  if(segments.some(s=>![s.from.price,s.to.price].every(positive)))return null;
  const status=failed!=null?"invalidated":reached!=null?"observed":confirmed!=null?"confirmed":"developing";
  const price=(n:number)=>Number(n.toPrecision(7)).toString();
  return {id:`${raw.id}:${[life.poleStartIndex,life.poleEndIndex,life.flagStartIndex,life.formationKnownAtIndex].map(i=>bars[i]!.time).join(":")}`,title:raw.name,status,
    ...(confirmed!=null?{confirmedAt:bars[confirmed]!.closeTime}:{}),asOf:last.closeTime,
    anchors:expected.map(p=>({...point(p.index,bars[p.index]!.close),role:p.role})),connectAnchors:false,segments,
    levels:[{price:trigger,label:confirmed!=null?"Breakout reference":failed!=null?"Channel reference at failure":"Projected channel trigger"},{price:invalidation,label:"Invalidation reference"}],
    explanation:`${bullish?"An upward":"A downward"} impulse was followed by a shallow counter-trend channel. Its slope and width were fixed from six closed candles. ${failed!=null?"A later close crossed the invalidation boundary; this formation is no longer valid.":reached!=null?"A closed candle reached the measured objective. That is a historical outcome, not a new entry signal.":confirmed!=null?"A later candle closed through the channel in the impulse direction.":`The shape is developing; the projected trigger at this observation is ${price(trigger)}. A wick alone does not confirm it.`} ${confirmed!=null?"The first closed breakout time is retained; later candles do not move it.":"There is no confirmed breakout for this formation."}${target===null?" No positive-price measured target is available for this formation.":""} This geometry does not establish a probability of future success.`,
    invalidation:`Before a breakout, a close through the opposite projected channel edge invalidates the shape. After a breakout, that opposite boundary freezes at the breakout observation.`,
    caveat:`${note} Flag discovery uses the latest 600 closed candles, an eight-candle pole and six-candle channel. Overlapping rolling formations are suppressed. Outcomes use closes; wick touches and earlier formations outside this window are not reconstructed.`};
}
