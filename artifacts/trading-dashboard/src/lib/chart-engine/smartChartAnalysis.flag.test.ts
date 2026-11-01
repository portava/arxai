import {afterEach,expect,it,vi} from "vitest";
import * as patterns from "@workspace/domain/chart-patterns";
import {analyzeSmartChart,type SmartChartAnalysisBar} from "./smartChartAnalysis";
import {smartChartFlagFinding} from "./smartChartFlagFinding";
const detect=patterns.detectChartPatterns;
afterEach(()=>vi.restoreAllMocks());
const row=(close:number)=>({open:close,high:close+.2,low:close-.2,close});
const formation=()=>[...Array.from({length:6},()=>row(100)),...Array.from({length:8},(_,i)=>row(100+i)),...Array.from({length:6},(_,i)=>row(106.8-i*.2))];
function input(extra:number[]=[],bear=false){
 const rows=[...formation(),...extra.map(row)].map(b=>bear?{open:220-b.open,high:220-b.low,low:220-b.high,close:220-b.close}:b);
 const bars:SmartChartAnalysisBar[]=rows.map((b,i)=>({...b,time:1700000000+i*300,closeTime:1700000000+(i+1)*300,isComplete:true,isFinal:true,isForming:false}));
 return {symbol:"EURUSD",timeframe:"M5",source:"mt5_broker",sourceIdentity:"a".repeat(64),bars,asOfMs:bars.at(-1)!.closeTime*1000,dataState:"current" as const};
}
it.each([1000,946000,-99.5])("binds valid flag geometry at translated price scale %s",offset=>{
 const data=input([106.2,106.3]);data.bars=data.bars.map(b=>({...b,open:b.open+offset,high:b.high+offset,low:b.low+offset,close:b.close+offset}));
 expect(detect(data.bars).patterns.find(p=>p.id==="bull_flag")?.status).toBe("confirmed");
 expect(analyzeSmartChart(data).allFindings.find(f=>f.id.startsWith("bull_flag"))?.status).toBe("confirmed");
});
it("rejects fabricated volatility even for very small positive price units",()=>{
 const data=input([106.2,106.3]),raw=detect(data.bars).patterns.find(p=>p.id==="bull_flag")!;
 data.bars=data.bars.map(b=>({...b,open:b.open*1e-20,high:b.high*1e-20,low:b.low*1e-20,close:b.close*1e-20}));
 // Exercise the evidence validator directly: the producer separately withholds
 // values unrepresentable in its legacy rounded public price fields.
 for(const key of ["channelSlope","upperAtStart","lowerAtStart","frozenAtr","confirmationLevel","invalidationLevel","targetLevel"] as const)raw.flagLifecycle![key]=raw.flagLifecycle![key]!*1e-20;
 raw.keyPoints=raw.keyPoints.map(p=>({...p,price:0}));raw.levels={confirmation:0,invalidation:0,targets:[0]};
 expect(smartChartFlagFinding(raw,data.bars,"test")).not.toBeNull();
 raw.flagLifecycle!.frozenAtr*=100;
 expect(smartChartFlagFinding(raw,data.bars,"test")).toBeNull();
});
it("retains observed bearish geometry when no positive-price measured target exists",()=>{
 const data=input();const closes=[...Array(6).fill(100),...Array.from({length:8},(_,i)=>100-i*10),...Array.from({length:6},(_,i)=>30.2+i*.2),30.8];
 data.bars=closes.map((close,i)=>({...row(close),time:1700000000+i*300,closeTime:1700000000+(i+1)*300,isComplete:true,isFinal:true,isForming:false}));data.asOfMs=data.bars.at(-1)!.closeTime*1000;
 const finding=analyzeSmartChart(data).allFindings.find(f=>f.id.startsWith("bear_flag"));
 expect(finding?.status).toBe("confirmed");expect(finding?.explanation).toContain("No positive-price measured target is available");expect(finding?.levels.every(l=>l.price>0)).toBe(true);
});
for(const bear of [false,true]){
 const prefix=bear?"bear_flag":"bull_flag",find=(extra:number[]=[])=>analyzeSmartChart(input(extra,bear)).allFindings.find(f=>f.id.startsWith(prefix));
 it(`${prefix} keeps exact first confirmation, stable identity and separate source-bound channel edges`,()=>{
  const a=find(),b=find([106.2]),c=find([106.2,106.3]);expect(a).toBeDefined();expect(b?.status).toBe("confirmed");expect(c?.confirmedAt).toBe(1700000000+21*300);expect(b?.confirmedAt).toBe(c?.confirmedAt);
  expect(a?.id).toBe(b?.id);expect(b?.id).toBe(c?.id);expect(b?.segments).toHaveLength(3);expect(b?.connectAnchors).toBe(false);
  expect(b?.anchors.map(p=>p.role)).toEqual(["flagpole_start","flagpole_end","flag_start","flag_end","flag_break"]);
  expect(b?.anchors.at(-1)?.price).toBe(bear?113.8:106.2);
 });
 it(`${prefix} retains invalidation and prior target/confirmation instead of issuing a new signal`,()=>{
  const failed=find([106.2,113,105,107]);expect(failed?.status).toBe("invalidated");expect(failed?.confirmedAt).toBe(1700000000+21*300);expect(failed?.explanation).toContain("no longer valid");
  const reached=find([106.2,113,107]);expect(reached?.status).toBe("observed");expect(reached?.explanation).toContain("historical outcome");
  const developing=find([105.6]);expect(developing?.levels[0]?.label).toBe("Projected channel trigger");expect(developing?.confirmedAt).toBeUndefined();expect(developing?.anchors.some(a=>a.role==="flag_break")).toBe(false);
 });
}
it.each(["missing","unknown version","bad index","wrong formation","wrong slope","wrong envelope","wrong ATR","wrong level index","wrong trigger","wrong target","wrong keypoint","wrong role","extra anchor","wrong rounded level","late confirmation","false failure","false target","wrong status"])("withholds flag with %s evidence",kind=>{
 const data=input([106.2,106.3]);expect(detect(data.bars).patterns.find(p=>p.id==="bull_flag")?.flagLifecycle).toBeDefined();
 vi.spyOn(patterns,"detectChartPatterns").mockImplementation((candles,scope)=>{
  const result=detect(candles,scope);return {...result,patterns:result.patterns.map(raw=>{
   if(raw.id!=="bull_flag")return raw;const p=structuredClone(raw),life=p.flagLifecycle!;
   switch(kind){
    case "missing":delete p.flagLifecycle;break;
    case "unknown version":life.version="unknown" as any;break;
    case "bad index":life.poleStartIndex=-1;break;
    case "wrong formation":life.flagStartIndex++;break;
    case "wrong slope":life.channelSlope-=.1;break;
    case "wrong envelope":life.upperAtStart+=.1;break;
    case "wrong ATR":life.frozenAtr+=1;break;
    case "wrong level index":life.levelAtIndex++;break;
    case "wrong trigger":life.confirmationLevel+=1;break;
    case "wrong target":life.targetLevel=(life.targetLevel??0)+1;break;
    case "wrong keypoint":p.keyPoints[0]!.price+=1;break;
    case "wrong role":p.keyPoints[0]!.role="flag_break";break;
    case "extra anchor":p.keyPoints.push(p.keyPoints[0]!);break;
    case "wrong rounded level":p.levels.confirmation=1;break;
    case "late confirmation":life.confirmedIndex=21;life.levelAtIndex=21;break;
    case "false failure":life.failedIndex=21;p.status="invalidated";break;
    case "false target":life.targetReachedIndex=20;p.status="exhausted";break;
    case "wrong status":p.status="forming";break;
   }return p;
  })};
 });
 expect(analyzeSmartChart(data).allFindings.some(f=>f.id.startsWith("bull_flag"))).toBe(false);
});
