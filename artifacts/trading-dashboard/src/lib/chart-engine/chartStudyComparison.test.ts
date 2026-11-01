import {describe,it,expect,vi} from "vitest";
import {StudyCalculator,studyDefinition,studyLabel,type ChartStudy} from "./chartStudies";
import {executeStudyRequest,parseStudyRequest} from "./chartStudyAssistant";
function fixture(initial:ChartStudy[]=[]){
 let studies=initial;
 const candles=Array.from({length:120},(_,i)=>({time:1_700_000_000+i*60,open:100+i*.2,high:101+i*.2,low:99+i*.2,close:100.5+i*.2}));
 const adapter={setStudies:vi.fn((next:ChartStudy[])=>{studies=next;}),getVisibleCandles:()=>candles.slice(80,110),getStudyValues:(time:number)=>studies.map(s=>({label:studyLabel(s),color:s.color,values:studyDefinition(s.kind).channels.map((name,index)=>({name,value:new StudyCalculator(s).calculate(candles).find(p=>p.time===time)?.values[index]??null}))}))};
 const save=vi.fn((next:ChartStudy[])=>{studies=next;});
 return {adapter,save,candles,studies:()=>studies,context:()=>({adapter,save,studies,symbol:"EURUSD",timeframe:"M1",feedLabel:"MT5 · Not live-confirmed"})};
}
const request=()=>parseStudyRequest("Compare the 20 EMA and 50 EMA.")!;
describe("current chart average comparison",()=>{
 it("recognizes the owner's complete comparison example",()=>{expect(request()).toEqual({action:"compare",studies:[{kind:"ema",period:20},{kind:"ema",period:50}]});});
 it("applies both real averages atomically, with distinct colors and actual renderer values",()=>{
  const f=fixture(),reply=executeStudyRequest(request(),f.context());
  expect(f.adapter.setStudies).toHaveBeenCalledTimes(1);expect(f.save).toHaveBeenCalledTimes(1);
  expect(f.studies().map(s=>[s.kind,s.period])).toEqual([["ema",20],["ema",50]]);expect(new Set(f.studies().map(s=>s.color)).size).toBe(2);
  const last=f.candles[109];for(const s of f.studies()){const expected=new StudyCalculator(s).calculate(f.candles).find(p=>p.time===last.time)!.values[0]!;expect(reply).toContain(String(Number(expected.toPrecision(8))));}
  expect(reply).toContain(new Date(last.time*1000).toISOString());expect(reply).toContain("EURUSD · M1");expect(reply).toContain("above");expect(reply).toContain("not a crossover");expect(reply).toContain("forming");
 });
 it("preserves existing calculation, style and other tools; explicit comparison reveals the pair",()=>{
  const original:ChartStudy={...studyDefinition("ema").defaults,id:"my-20",period:20,source:"open",color:"#123456",lineStyles:[{visible:false,width:3}]};
  const other:ChartStudy={...studyDefinition("rsi").defaults,id:"my-rsi"};const f=fixture([original,other]);
  const reply=executeStudyRequest(request(),f.context());expect(f.studies()).toHaveLength(3);expect(f.studies()[0]).toMatchObject({id:"my-20",period:20,source:"open",color:"#123456",lineStyles:[{visible:true,width:3}]});expect(f.studies()[1]).toEqual(other);expect(original.lineStyles![0].visible).toBe(false);expect(reply).toContain("open");expect(reply).toContain("both enabled for display");
 });
 it("reuses an existing pair without duplication on repeated requests",()=>{const f=fixture();executeStudyRequest(request(),f.context());const ids=f.studies().map(s=>s.id);executeStudyRequest(request(),f.context());expect(f.studies()).toHaveLength(2);expect(f.studies().map(s=>s.id)).toEqual(ids);});
 it("does not give a new line the same visible color as an uppercase manual override",()=>{const f=fixture([{...studyDefinition("ema").defaults,id:"manual",period:20,lineStyles:[{color:"#38BDF8"}]}]);executeStudyRequest(request(),f.context());expect(f.studies()[1].color.toLowerCase()).not.toBe("#38bdf8");expect(f.studies()[0].lineStyles![0].color).toBe("#38BDF8");});
 it("does not guess between repeated matching manual instances",()=>{const base={...studyDefinition("ema").defaults,period:20};const f=fixture([{...base,id:"a"},{...base,id:"b",source:"open"}]);expect(executeStudyRequest(request(),f.context())).toMatch(/multiple|ambiguous/i);expect(f.adapter.setStudies).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();});
 it("checks capacity for the whole pair before touching the renderer",()=>{const f=fixture(Array.from({length:12},(_,i)=>({...studyDefinition("sma").defaults,id:`manual-${i}`,period:100+i})));expect(executeStudyRequest(request(),f.context())).toMatch(/limit|capacity/i);expect(f.adapter.setStudies).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();});
 it.each(["compare 20 EMA and 20 EMA","compare 0 EMA and 50 EMA","compare 20 EMA and 1001 EMA","compare 20 EMA and 50 EMA on GBPUSD","compare 20 EMA and 50 EMA on M5","compare 20 EMA and 50 EMA and buy","compare 20.5 EMA and 50 EMA","do not compare 20 EMA and 50 EMA","compare 20 EMA and 50 EMA using high"])("refuses extra or unsupported intent without partial changes: %s",text=>{const f=fixture();expect(executeStudyRequest(parseStudyRequest(text)!,f.context())).toMatch(/not changed/i);expect(f.adapter.setStudies).not.toHaveBeenCalled();});
 it("never invents a comparison when one renderer value is warming up",()=>{const f=fixture();const reply=executeStudyRequest(parseStudyRequest("compare 20 SMA with 500 EMA")!,f.context());expect(f.studies()).toHaveLength(2);expect(reply).toContain("warming up");expect(reply).not.toContain("is above");expect(reply).not.toContain("is below");});
 it("restores previous studies after a partial renderer failure and never saves the failed pair",()=>{const f=fixture([studyDefinition("rsi").defaults]);const previous=f.studies();f.adapter.setStudies.mockImplementationOnce(()=>{throw Error("partial write");});expect(executeStudyRequest(request(),f.context())).toMatch(/could not be verified/i);expect(f.adapter.setStudies).toHaveBeenLastCalledWith(previous);expect(f.save).not.toHaveBeenCalled();});
 it("reports uncertainty and restores the renderer if preference saving throws",()=>{const f=fixture([studyDefinition("rsi").defaults]);const previous=f.studies();f.save.mockImplementationOnce(()=>{throw Error("storage unavailable");});expect(executeStudyRequest(request(),f.context())).toContain("Settings may be incomplete");expect(f.adapter.setStudies).toHaveBeenLastCalledWith(previous);});
 it("does not manufacture values when the renderer read fails",()=>{const f=fixture();f.adapter.getStudyValues=()=>{throw Error("read unavailable");};const reply=executeStudyRequest(request(),f.context());expect(reply).toContain("numerical comparison is unavailable");expect(reply).not.toContain("is above");expect(f.save).toHaveBeenCalledTimes(1);});
 it("does not mistake nonfinite renderer values for a valid comparison",()=>{const f=fixture();f.adapter.getStudyValues=()=>[{label:studyLabel({...studyDefinition("ema").defaults,period:20}),color:"blue",values:[{name:"EMA",value:NaN}]},{label:studyLabel({...studyDefinition("ema").defaults,period:50}),color:"red",values:[{name:"EMA",value:Infinity}]}];expect(executeStudyRequest(request(),f.context())).toContain("numerical comparison is unavailable");});
 it("discloses source coordinate times without asserting UTC provenance",()=>{const f=fixture();expect(executeStudyRequest(request(),f.context())).toContain("ISO formatting does not independently prove UTC");});
});
