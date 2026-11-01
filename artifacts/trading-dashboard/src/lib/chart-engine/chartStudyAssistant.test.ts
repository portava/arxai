import { describe, expect, it, vi } from "vitest";
import { STUDY_CATALOG, StudyCalculator, studyDefinition, studyLabel, type ChartStudy } from "./chartStudies";
import { executeStudyRequest, parseStudyRequest, registerChartStudyAssistant, requestChartStudy } from "./chartStudyAssistant";

function fixture(qualifiedTrade=false) {
  let studies: ChartStudy[] = [];
  const candles = Array.from({length:40},(_,i)=>({time:1700000000+i*60,open:100+i,high:102+i,low:99+i,close:101+i,...(qualifiedTrade ? {volumeEvidence:{kind:"real_volume" as const,unit:"provider_trade_units" as const,quantity:2,reason:null,authority:"twelve-data:time-series:common-stock:regular-unadjusted:v1",seriesIdentity:"a".repeat(64)}} : {})}));
  const adapter = {
    setStudies: vi.fn((next:ChartStudy[])=>{ studies=next; }),
    getVisibleCandles: ()=>candles.slice(25,35),
    getStudyValues: (time:number)=>studies.map(study=>({label:studyLabel(study),color:study.color,values:studyDefinition(study.kind).channels.map((name,index)=>({name:study.lineStyles?.[index]?.visible===false ? `${name} (hidden)` : name,value:new StudyCalculator(study).calculate(candles).find(p=>p.time===time)?.values[index]??null}))})),
  };
  const save = vi.fn((next:ChartStudy[])=>{studies=next;});
  return {adapter,save,context:()=>({adapter,studies,symbol:"V75",timeframe:"M1",feedLabel:"MT5 · Not live-confirmed",save}),studies:()=>studies};
}

describe("existing assistant to current chart study action",()=>{
  it.each(STUDY_CATALOG.map(d=>[d.defaults.kind] as const))("applies existing catalogue kind %s without introducing a calculation",kind=>{
    const f=fixture(kind === "vwap"); expect(executeStudyRequest(parseStudyRequest(`show ${kind}`)!,f.context())).toContain("Applied");
    expect(f.studies()[0].kind).toBe(kind);
  });
  it.each(STUDY_CATALOG.map(d=>[d.name] as const))("recognizes existing full catalogue name %s",name=>{
    const f=fixture(name === "Anchored VWAP"); expect(executeStudyRequest(parseStudyRequest(`show ${name}`)!,f.context())).toContain("Applied");
  });
  it("curiosity applies RSI and explains the actual visible bar using the existing calculator",()=>{
    const f=fixture(); const response=executeStudyRequest(parseStudyRequest("What does RSI tell me about this chart?")!,f.context());
    expect(f.adapter.setStudies).toHaveBeenCalledOnce(); expect(f.studies()).toHaveLength(1);
    expect(response).toContain("RSI (14)"); expect(response).toContain("RSI: 100");
    expect(response).toContain("V75 · M1"); expect(response).toContain("Not live-confirmed");
    expect(response).toContain("2023-11-14 22:47:20 source clock (UTC unverified)");
    expect(response).not.toContain("2023-11-14T22:47:20.000Z");
    expect(response).toContain("not a buy/sell instruction");
  });
  it("manual settings survive curiosity, period edits use that same instance, and remove is real",()=>{
    const f=fixture(); executeStudyRequest(parseStudyRequest("add RSI 21")!,f.context());
    executeStudyRequest(parseStudyRequest("explain RSI")!,f.context());
    expect(f.studies()).toHaveLength(1); expect(f.studies()[0].period).toBe(21);
    executeStudyRequest(parseStudyRequest("set RSI period to 10")!,f.context());
    expect(f.studies()[0].period).toBe(10);
    executeStudyRequest(parseStudyRequest("remove RSI")!,f.context()); expect(f.studies()).toEqual([]);
  });
  it("prints actual MACD and Bollinger defaults, not an unspecified default claim",()=>{
    const f=fixture();
    expect(executeStudyRequest(parseStudyRequest("show MACD")!,f.context())).toContain("MACD (12, 26, 9) · close · EMA signal");
    expect(executeStudyRequest(parseStudyRequest("show Bollinger Bands")!,f.context())).toContain("BOLLINGER (20, 2) · close");
  });
  it("period edits preserve hidden RSI and explain hidden actual values without calling them warmup",()=>{
    const f=fixture(); executeStudyRequest(parseStudyRequest("show RSI")!,f.context());
    executeStudyRequest(parseStudyRequest("hide RSI")!,f.context());
    const reply=executeStudyRequest(parseStudyRequest("set RSI period to 10")!,f.context());
    expect(f.studies()[0].lineStyles?.[0]?.visible).toBe(false);
    expect(reply).toContain("RSI (hidden): 100"); expect(reply).toContain("visibility retained");
    expect(reply).not.toContain("warming up");
  });
  it("explicit show reveals manual MACD channels and discloses the visibility change",()=>{
    const f=fixture(); const c=f.context();c.studies=[{...studyDefinition("macd").defaults,lineStyles:[{}, {visible:false}, {visible:false}]}];
    const reply=executeStudyRequest(parseStudyRequest("show MACD")!,c);
    expect(f.studies()[0].lineStyles?.every(s=>s.visible)).toBe(true);
    expect(reply).toContain("all channels shown");
  });
  it("compares the underlying source close, never a transformed display close",()=>{
    const f=fixture(); const reply=executeStudyRequest(parseStudyRequest("show SMA")!,f.context());
    expect(reply).toContain("underlying source candle close"); expect(reply).toContain("not averaged display candles");
    expect(reply).not.toContain("visible candle close");
  });
  it("hide/show uses existing channel visibility, not a second chart",()=>{
    const f=fixture(); executeStudyRequest(parseStudyRequest("show MACD")!,f.context());
    executeStudyRequest(parseStudyRequest("hide MACD")!,f.context());
    expect(f.studies()[0].lineStyles?.every(s=>s.visible===false)).toBe(true);
    executeStudyRequest(parseStudyRequest("show MACD")!,f.context());
    expect(f.studies()).toHaveLength(1); expect(f.studies()[0].lineStyles?.every(s=>s.visible===true)).toBe(true);
  });
  it.each(["add RSI on EURUSD", "RSI on M5", "add RSI and EMA", "do not add RSI", "set RSI period to 0", "set RSI period to 1001", "add RSI using open", "add MACD 30", "add RSI 14.5"])("rejects unsupported/ambiguous settings without action: %s",text=>{
    const f=fixture(); const result=executeStudyRequest(parseStudyRequest(text)!,f.context());
    expect(result).toMatch(/not changed|not applied/i); expect(f.adapter.setStudies).not.toHaveBeenCalled();
  });
  it("refuses ambiguity between repeated manual studies",()=>{
    const f=fixture(); const c=f.context(); c.studies=[{...studyDefinition("rsi").defaults,id:"one"},{...studyDefinition("rsi").defaults,id:"two",period:21}];
    expect(executeStudyRequest(parseStudyRequest("show RSI")!,c)).toContain("multiple"); expect(f.adapter.setStudies).not.toHaveBeenCalled();
  });
  it("does not report a calculated number before warmup",()=>{
    const f=fixture(); const response=executeStudyRequest(parseStudyRequest("add EMA 100")!,f.context());
    expect(response).toContain("warming up"); expect(response).not.toMatch(/EMA: 0/);
  });
  it("uses mounted current chart only, cleans up safely, leaves ordinary conversation alone",()=>{
    expect(requestChartStudy("hello")).toBeNull(); expect(requestChartStudy("show RSI")).toContain("Select a ready");
    const a=registerChartStudyAssistant(()=>"old"); const b=registerChartStudyAssistant(()=>"current"); a();
    expect(requestChartStudy("show RSI")).toBe("current"); b(); expect(requestChartStudy("show RSI")).toContain("Select a ready");
  });
  it("marks nonfinite renderer values unavailable rather than inventing zero",()=>{
    const f=fixture(); f.adapter.getStudyValues=()=>[{label:"RSI (14) · close",color:"#fff",values:[{name:"RSI",value:NaN}]}];
    const reply=executeStudyRequest(parseStudyRequest("show RSI")!,f.context());
    expect(reply).toContain("unavailable / warming up"); expect(reply).not.toContain("RSI: NaN");
  });
  it("renderer failure never saves preferences or falsely proves no mutation",()=>{
    const f=fixture(); f.adapter.setStudies.mockImplementation(()=>{throw new Error("renderer failed");});
    expect(executeStudyRequest(parseStudyRequest("show RSI")!,f.context())).toContain("could not be verified");
    expect(f.save).not.toHaveBeenCalled();
  });
  it("does not claim application without a ready viewport/renderer",()=>{
    const f=fixture(); f.adapter.getVisibleCandles=()=>[];
    expect(executeStudyRequest(parseStudyRequest("show RSI")!,f.context())).toContain("not applied"); expect(f.save).not.toHaveBeenCalled();
  });
});
