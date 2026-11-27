import {test} from "node:test";
import assert from "node:assert/strict";
import {fitVolRangeProfile,seasonalBandAt,seasonalVolatilityBand} from "./volRange.js";
import {forecastRangeCoverage,uniqueHorizonScores} from "./scorecard.js";
import type {StructuralBar,StructuralForecast,ForecastScore} from "./contracts.js";
const step=900000,t=Date.UTC(2026,0,1);
const bars:StructuralBar[]=Array.from({length:200},(_,i)=>({openTime:t+i*step,closeTime:t+(i+1)*step,open:100+i*.01,high:101+i*.01,low:99+i*.01,close:100.2+i*.01,isFinal:true}));
test("a later volatility fit cannot forecast earlier history",()=>{
 const p=fitVolRangeProfile(bars,150,step)!;
 assert.ok(p);assert.equal(seasonalBandAt(bars.slice(0,100),p,60),null);
 assert.equal(seasonalVolatilityBand(.001,bars[99]!.openTime,p,60),null);
 assert.ok(seasonalBandAt(bars.slice(0,150),p,60));
});
test("fit ignores future candles and invalid profile/history fails closed",()=>{
 const p=fitVolRangeProfile(bars,100,step)!;
 const changed=bars.map((b,i)=>i>=100?{...b,close:999}:b);
 assert.deepEqual(fitVolRangeProfile(changed,100,step),p);
 assert.equal(fitVolRangeProfile(bars,999,step),null);
 assert.equal(fitVolRangeProfile([{...bars[0]!,isFinal:false},...bars.slice(1)],100,step),null);
 assert.equal(seasonalBandAt(bars,{...p,factor:[NaN]},60),null);
 assert.equal(seasonalBandAt(bars,p,Infinity),null);
 assert.equal(seasonalBandAt([...bars].reverse(),p,60),null);
 const band=seasonalBandAt(bars,p,60)!;
 assert.ok(band.bull.every((v,i)=>Number.isFinite(v)&&v>=0&&(i===0||v>=band.bull[i-1]!)));
});
const score=(inside=true)=>({horizon:60,observedThrough:t+3600000,grade:{insideRange:inside},brier:.3,baselineBrier:.4,logLoss:.5} as ForecastScore);
const row=(id:string,asOf=t)=>({id,forecast:{asOf,horizonId:"1h",stepMs:60000,horizonBars:60} as StructuralForecast,scores:[{...score(),observedThrough:asOf+3600000}]});
test("appended grades do not double count outcomes",()=>{
 assert.equal(uniqueHorizonScores([{...score(),grade:undefined},score()],60).length,1);
 assert.ok(uniqueHorizonScores([{...score(),grade:undefined},score()],60)[0]!.grade);
});
test("coverage excludes updates, overlap, future/unresolved outcomes and duplicate receipts",()=>{
 const a=row("a"), b=row("b",t+60000), c=row("c",t+3600000), d=row("d",t+7200000);
 c.scores[0]!.grade!.insideRange=false;
 const update={...row("update",t+3600000),forecast:{...row("x").forecast,update:{of:"a"} as StructuralForecast["update"]}};
 const out=forecastRangeCoverage([d,b,a,c,a,update],"1h",t+7200000);
 assert.equal(out.n,2);assert.equal(out.coverage,.5);assert.equal(out.excluded,3);
 assert.equal(out.evidenceClass,"DESCRIPTIVE_ONLY");
});
