import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadVerifiedMarketsFixture } from "./marketsHistoryFixture.js";
import { TIMEFRAME_SECONDS } from "./intradayHistoryFixture.js";
import { fitVolRangeProfile, deseasonalisedLevels, seasonalVolatilityBand, type StructuralBar } from "@workspace/domain/structural";
const output = process.argv[2];
if (!output) throw new Error("output JSON path required");
const { manifest, instruments } = loadVerifiedMarketsFixture(fileURLToPath(new URL("../../fixtures", import.meta.url)));
const series = instruments.map(inst => {
 const step = TIMEFRAME_SECONDS[inst.spec.timeframe] * 1000;
 const bars: StructuralBar[] = inst.bars.map((b,i)=>({...b,openTime:Date.parse(inst.dates[i]!),closeTime:Date.parse(inst.dates[i]!)+step,isFinal:true}));
 const start0=Math.floor(bars.length*.4), len=Math.floor((bars.length-start0)/6);
 const origins: Array<{index:number;lo:number[];hi:number[]}> = [];
 let i=Math.ceil(start0/60)*60;
 for(let block=0;block<6;block++) {
  const start=start0+block*len, end=block===5?bars.length:start+len;
  const profile=fitVolRangeProfile(bars,start,step);
  if(!profile) throw new Error("missing production profile");
  const levels=deseasonalisedLevels(bars,profile);
  for(;i<end&&i+60<bars.length;i+=60){
   const band=seasonalVolatilityBand(levels[i-1]!,bars[i-1]!.openTime,profile,60);
   if(!band)throw new Error("missing production band");
   origins.push({index:i,lo:[15,30,60].map(j=>band.bear[j-1]!),hi:[15,30,60].map(j=>band.bull[j-1]!)});
  }
 }
 return {symbol:inst.spec.symbol,timeframe:inst.spec.timeframe,closes:bars.map(b=>b.close),times:bars.map(b=>b.closeTime),origins};
});
writeFileSync(output, JSON.stringify({version:"arx-forecast-library-benchmark-v1",manifest,series}));
console.log(JSON.stringify({series:series.length,origins:series.reduce((s,r)=>s+r.origins.length,0),output}));
