import {useMemo} from 'react';
import type {DeepReadonly,ResearchCashAccount,ResearchV2Result} from '@workspace/domain/backtest/research-core';
const number=(value:number)=>Number.isFinite(value)?Number(value.toPrecision(15)).toString():'Unavailable';
type Point={time:number;value:number};
/** Keep real observations only: bucket endpoints/extrema plus the peak and
 * trough of both maximum absolute and percentage drawdown. Other intrabucket
 * turns may be omitted; metrics always use the complete engine curve. */
export function cashCurveDisplayPoints(points:readonly Point[]):Point[]{
 if(points.length<=1024)return [...points];
 const selected=new Set<number>(),size=Math.ceil(points.length/256);
 for(let i=0;i<points.length;i+=size){const end=Math.min(points.length,i+size);let low=i,high=i;for(let j=i+1;j<end;j++){if(points[j].value<points[low].value)low=j;if(points[j].value>points[high].value)high=j;}for(const index of [i,low,high,end-1])selected.add(index);}
 let peak=0,maxDrop=0,maxPercent=0,absolute=[0,0],percentage=[0,0];
 for(let i=1;i<points.length;i++){
  if(points[i].value>points[peak].value)peak=i;
  const drop=points[peak].value-points[i].value,percent=points[peak].value>0?drop/points[peak].value:0;
  if(drop>maxDrop){maxDrop=drop;absolute=[peak,i];}if(percent>maxPercent){maxPercent=percent;percentage=[peak,i];}
 }
 for(const index of [...absolute,...percentage])selected.add(index);
 return [...selected].sort((a,b)=>a-b).map(index=>points[index]);
}
function Curve({account,start,label}:{account:DeepReadonly<ResearchCashAccount>;start:number;label:string}){
 const geometry=useMemo(()=>{
  const equity=[{time:start,value:account.initialCapital},...account.curve.map(p=>({time:p.observedThroughMs,value:p.equity}))];
  const benchmark=[{time:start,value:account.initialCapital},...account.curve.map(p=>({time:p.observedThroughMs,value:p.benchmarkEquity}))];
  let min=account.initialCapital,max=min;for(const p of [...equity,...benchmark]){min=Math.min(min,p.value);max=Math.max(max,p.value);}
  const span=max-min||Math.max(Math.abs(max)*.01,1),end=equity.at(-1)!.time;
  const y=(value:number)=>140-(value-min)/span*116;
  const line=(points:readonly Point[])=>cashCurveDisplayPoints(points).map(p=>`${24+(p.time-start)/Math.max(1,end-start)*752},${y(p.value)}`).join(' ');
  return{equity:line(equity),benchmark:line(benchmark),baseline:y(account.initialCapital),min,max};
 },[account,start]);
 return <figure className="min-w-0 rounded border border-zinc-700 p-2">
  <figcaption className="text-xs">{label} · marked equity ({account.unitLabel})</figcaption>
  <svg viewBox="0 0 800 164" role="img" aria-label={`${label} marked equity and same-quantity buy-and-hold`} className="h-40 w-full"><title>{label}: marked equity and same-quantity buy-and-hold</title><desc>Each line joins observed closes after modeled liquidation costs. The initial point is starting capital. Long series retain bucket endpoints, extremes and maximum-drawdown turning points, without averaging; other turns may be omitted. No intrabar path is observed.</desc><line x1="24" x2="776" y1={geometry.baseline} y2={geometry.baseline} stroke="#71717a" strokeDasharray="4 4"/><polyline points={geometry.benchmark} fill="none" stroke="#a78bfa" strokeWidth="2"/><polyline points={geometry.equity} fill="none" stroke="#22d3ee" strokeWidth="2"/><text x="24" y="14" fill="#a1a1aa" fontSize="11">{number(geometry.max)}</text><text x="24" y="160" fill="#a1a1aa" fontSize="11">{number(geometry.min)}</text></svg>
  <p className="text-[11px] text-zinc-400"><span className="text-cyan-300">Cyan: strategy</span> · <span className="text-violet-300">Purple: same-quantity buy-and-hold</span> · dashed: initial cash. Observed closes only; connecting lines do not establish intrabar values. Long curves retain bucket extremes and maximum-drawdown turns; other fluctuations may be omitted. {new Date(start).toISOString()} to {new Date(account.curve.at(-1)!.observedThroughMs).toISOString()}.</p>
 </figure>;
}
/** Receives only a result that passed the existing source/ledger binding and
 * cash-account verifier. Never calculates alternative fills or performance. */
export function ChartResearchCashPanel({result}:{result:DeepReadonly<ResearchV2Result>}){
 const scenario=result.configSnapshot.cash;if(!scenario)return null;
 return <section aria-label="Cash-funded historical scenario" className="space-y-3">
  <p className="text-xs">Hypothetical fully paid asset · {scenario.initialCapital} {scenario.unitLabel} starting capital per partition · quantity {scenario.fixedQuantity} · point value {scenario.pointValue} {scenario.unitLabel} per price unit per quantity unit. These are explicit scenario inputs, not broker lots, actual currency conversion or margin rules.</p>
  {result.partitions.map(p=>{const account=p.cash;if(!account)return null;const label=p.name==='train'?'Development':p.name==='validation'?'Validation':'Holdout';return <details key={p.name} className="rounded border border-zinc-700 p-3" open={p.name==='holdout'}><summary className="cursor-pointer text-xs">{label} · marked equity {number(account.lastEquity)} {account.unitLabel} · return {number(account.totalReturnPercent)}%</summary>
    <dl className="my-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">{[['Completed net',number(account.completedNet)],['Completed trade costs',number(account.completedCosts)],['Observed-close drawdown',`${number(account.maxDrawdown)} (${number(account.maxDrawdownPercent)}%)`],['Annualized equivalent',account.annualizedReturnPercent==null?'Unavailable: under 365.25 days or nonpositive terminal equity':`${number(account.annualizedReturnPercent)}%`],['Same-quantity buy-and-hold',`${number(account.benchmark.lastEquity)} (${number(account.benchmark.totalReturnPercent)}%)`],['Unfunded strategy entries',String(p.decisions.filter(d=>d.disposition==='insufficient_capital').length)]].map(([term,value])=><div key={term}><dt className="text-zinc-400">{term}</dt><dd>{value}</dd></div>)}</dl>
    {account.capitalDeficit&&<p role="alert" className="my-2 text-xs text-amber-300">The modeled balance fell below zero. Exit fees can exceed sale proceeds; losses were not clamped or presented as bounded by starting capital.</p>}
    <p className="mb-2 text-xs text-zinc-400">{account.benchmark.status==='insufficient_capital'?'Buy-and-hold could not afford the requested quantity at the first open and remains flat cash. No cheaper entry or smaller size was substituted.':'Buy-and-hold remains open and is marked with hypothetical exit costs; no final sale is claimed.'} Strategy open positions likewise remain unresolved. Completed costs exclude unresolved-position costs. Each partition starts independently; these curves are not one continuous funded account.</p>
    <Curve account={account} start={result.inputSnapshot.bars[p.fromInclusive].openTimeMs} label={label}/>
   </details>;})}
 </section>;
}
