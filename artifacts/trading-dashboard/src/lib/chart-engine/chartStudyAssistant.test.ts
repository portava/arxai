import {calculateVolumeProfile} from "./chartVolumeProfile";
import {TRADE_VOLUME_AUTHORITY} from "./chartVolume";
import { describe, expect, it, vi } from "vitest";
import { STUDY_CATALOG, StudyCalculator, studyDefinition, studyLabel, type ChartStudy } from "./chartStudies";
import { executeStudyRequest, parseStudyRequest, registerChartStudyAssistant, requestChartStudy } from "./chartStudyAssistant";

function fixture(qualifiedTrade=false) {
  let studies: ChartStudy[] = [];
  const candles = Array.from({length:40},(_,i)=>({time:1700000000+i*60,open:100+i,high:102+i,low:99+i,close:101+i,...(qualifiedTrade ? {volumeEvidence:{kind:"real_volume" as const,unit:"provider_trade_units" as const,quantity:2,reason:null,authority:"twelve-data:time-series:common-stock:regular-unadjusted:v1",seriesIdentity:"a".repeat(64)},profileEvidence:{finality:"closed" as const,clockAuthority:TRADE_VOLUME_AUTHORITY}} : {})}));
  const adapter = {
    setStudies: vi.fn((next:ChartStudy[])=>{ studies=next; }),
    getVisibleCandles: ()=>candles.slice(25,35),
    getVolumeProfiles: ()=>studies.filter(s=>s.kind==="volume_profile").map(s=>({id:s.id??s.kind,label:studyLabel(s),visible:s.lineStyles?.[0]?.visible!==false,result:calculateVolumeProfile(candles,s.profileRange,s.profileRows??32,s.profileValueAreaPercent??70)})),
    getStudyValues: (time:number)=>studies.map(study=>({label:studyLabel(study),color:study.color,values:studyDefinition(study.kind).channels.map((name,index)=>({name:study.lineStyles?.[index]?.visible===false ? `${name} (hidden)` : name,value:new StudyCalculator(study).calculate(candles).find(p=>p.time===time)?.values[index]??null}))})),
  };
  const save = vi.fn((next:ChartStudy[])=>{studies=next;});
  return {adapter,save,context:()=>({adapter,studies,symbol:"V75",timeframe:"M1",feedLabel:"MT5 · Not live-confirmed",save}),studies:()=>studies};
}

describe("existing assistant to current chart study action",()=>{
  it.each(STUDY_CATALOG.map(d=>[d.defaults.kind] as const))("applies existing catalogue kind %s without introducing a calculation",kind=>{
    const f=fixture(kind === "vwap" || kind === "volume_profile"); expect(executeStudyRequest(parseStudyRequest(`show ${kind}`)!,f.context())).toContain("Applied");
    expect(f.studies()[0].kind).toBe(kind);
  });
  it.each(STUDY_CATALOG.map(d=>[d.name] as const))("recognizes existing full catalogue name %s",name=>{
    const f=fixture(name === "Anchored VWAP" || name === "Estimated volume profile"); expect(executeStudyRequest(parseStudyRequest(`show ${name}`)!,f.context())).toContain("Applied");
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


describe("manual-equivalent MACD and Bollinger assistant settings",()=>{
  it.each([
    ["set MACD periods to 8, 21, 5",{period:8,slow:21,signal:5}],
    ["set MACD fast to 8",{period:8}],
    ["set MACD slow period to 30",{slow:30}],
    ["set MACD signal period to 5",{signal:5}],
    ["set MACD signal method to SMA",{signalMethod:"sma"}],
    ["set Bollinger Bands deviation to 2.5",{multiplier:2.5}],
  ])("applies explicit setting through the same study instance: %s",(text,patch)=>{
    const f=fixture();const kind=text.includes("MACD")?"macd":"bollinger";
    const original={...studyDefinition(kind).defaults,id:"manual",source:"open" as const,lineStyles:[{visible:false,color:"#abcdef"},{visible:true},{visible:false}]};
    f.save([original]);const reply=executeStudyRequest(parseStudyRequest(text)!,f.context());
    expect(reply).toContain("Applied");expect(f.studies()).toEqual([{...original,...patch}]);expect(reply).toContain("visibility retained");
  });
  it("applies a complete MACD tuple atomically even when the new fast exceeds the old slow",()=>{
    const f=fixture();executeStudyRequest(parseStudyRequest("show MACD")!,f.context());f.adapter.setStudies.mockClear();
    expect(executeStudyRequest(parseStudyRequest("set MACD periods to 30, 45, 8")!,f.context())).toContain("Applied");
    expect(f.adapter.setStudies).toHaveBeenCalledOnce();expect(f.studies()[0]).toMatchObject({period:30,slow:45,signal:8});
  });
  it.each(["set MACD periods to 21, 8, 5","set MACD periods to 8, 8, 5","set MACD signal to 0","set MACD slow to 1001","set MACD fast to 30","set MACD signal method to WMA","set Bollinger Bands deviation to 0","set Bollinger Bands deviation to 101","set Bollinger Bands deviation to NaN","set MACD periods to 8, 21, 5 on BTCUSD","set MACD fast to 8 and buy","do not set MACD fast to 8"])("refuses without mutation: %s",text=>{
    const f=fixture();const reply=executeStudyRequest(parseStudyRequest(text)!,f.context());expect(reply).toMatch(/not changed/i);expect(f.save).not.toHaveBeenCalled();expect(f.adapter.setStudies).not.toHaveBeenCalled();
  });
  it.each([
    ["set MACD periods to 5, 12, 3",{...studyDefinition("macd").defaults,period:5,slow:12,signal:3}],
    ["set Bollinger Bands deviation to 2.5",{...studyDefinition("bollinger").defaults,multiplier:2.5}],
  ])("manual and assistant settings produce identical complete study series: %s",(text,manual)=>{
    const f=fixture();executeStudyRequest(parseStudyRequest(text)!,f.context());
    const candles=Array.from({length:100},(_,i)=>({time:1700000000+i*60,open:100+Math.sin(i),high:102+Math.sin(i),low:98+Math.sin(i),close:101+Math.sin(i)}));
    expect(new StudyCalculator(f.studies()[0]).calculate(candles)).toEqual(new StudyCalculator(manual).calculate(candles));
  });
  it("a rejected settings transaction preserves manual values after a renderer failure",()=>{
    const f=fixture();const old={...studyDefinition("macd").defaults,id:"kept"};f.save([old]);f.save.mockClear();f.adapter.setStudies.mockImplementationOnce(()=>{throw Error("failed renderer");});
    expect(executeStudyRequest(parseStudyRequest("set MACD periods to 8, 21, 5")!,f.context())).toContain("could not be verified");expect(f.save).not.toHaveBeenCalled();expect(f.studies()).toEqual([old]);
  });
  it("does not choose between repeated manual MACDs",()=>{
    const f=fixture();f.save([{...studyDefinition("macd").defaults,id:"a"},{...studyDefinition("macd").defaults,id:"b"}]);f.adapter.setStudies.mockClear();expect(executeStudyRequest(parseStudyRequest("set MACD fast to 8")!,f.context())).toContain("multiple");expect(f.adapter.setStudies).not.toHaveBeenCalled();
  });
  it.each(["show me MACD","Please show me Bollinger Bands on this chart","show me volume profile"])("accepts ordinary show-me phrasing: %s",text=>{expect(parseStudyRequest(text)).toMatchObject({action:"show"});});
  it("refuses an invalid internal setting through the manual validator",()=>{
    const f=fixture();expect(executeStudyRequest({kind:"macd",action:"show",period:30},f.context())).toContain("not changed");expect(f.adapter.setStudies).not.toHaveBeenCalled();
  });
});

describe("data-based MACD and Bollinger explanations",()=>{
  const observation=(kind:"macd"|"bollinger"|"rsi",values:{name:string;value:number|null}[])=>{
    const f=fixture();f.adapter.getStudyValues=()=>[{label:studyLabel(studyDefinition(kind).defaults),color:"#fff",values}];return executeStudyRequest(parseStudyRequest(`explain ${kind}`)!,f.context());
  };
  it("uses named MACD channels even when returned out of order",()=>{
    const text=observation("macd",[{name:"Histogram",value:1},{name:"Signal",value:2},{name:"MACD",value:3}]);
    expect(text).toContain("MACD is above its signal");expect(text).toContain("MACD is above zero");expect(text).toContain("not a crossover");
  });
  it("never replaces unavailable signal with zero",()=>{
    const text=observation("macd",[{name:"MACD",value:3},{name:"Signal",value:null},{name:"Histogram",value:null}]);expect(text).toContain("MACD/signal comparison is unavailable");expect(text).not.toContain("MACD is above its signal");
  });
  it("explains a current close above the upper band without inferring a breakout",()=>{
    const text=observation("bollinger",[{name:"Upper",value:120},{name:"Basis",value:110},{name:"Lower",value:100}]);expect(text).toContain("source candle close is above the upper band");expect(text).toContain("Band width: 20 source price units");expect(text).toContain("does not establish a breakout or reversal");
  });
  it("refuses inverted bands and never calls them a valid range",()=>{
    const text=observation("bollinger",[{name:"Upper",value:100},{name:"Basis",value:110},{name:"Lower",value:120}]);expect(text).toContain("Band comparison is unavailable");expect(text).not.toContain("Band width:");
  });
  it("zero-width bands remain explicit without division by zero",()=>{
    const text=observation("bollinger",[{name:"Upper",value:135},{name:"Basis",value:135},{name:"Lower",value:135}]);expect(text).toContain("Band width: 0 source price units");expect(text).not.toMatch(/NaN|Infinity/);
  });
  it("RSI interpretation reads the named channel, never another first row",()=>{
    const text=observation("rsi",[{name:"unrelated",value:100},{name:"RSI",value:40}]);expect(text).toContain("between the common 30 and 70");expect(text).not.toContain("at or above 70");
  });
});

describe("temporary chart readability through the existing assistant",()=>{
  function focusedFixture(){
    const f=fixture();let focused=false;
    const adapter={...f.adapter,isAnalysisFocused:()=>focused,setAnalysisFocus:vi.fn((next:boolean)=>{focused=next;})};
    const notify=vi.fn();return {...f,adapter,notify,context:()=>({...f.context(),adapter,onAnalysisFocus:notify})};
  }
  it.each(["simplify chart","simplify this chart","make this chart easier to understand","focus on price"])("recognizes one bounded command: %s",text=>expect(parseStudyRequest(text)).toEqual({action:"simplify"}));
  it.each(["restore chosen tools","restore my tools","restore this chart"])("recognizes restoration: %s",text=>expect(parseStudyRequest(text)).toEqual({action:"restore"}));
  it.each(["do not simplify chart","simplify chart and buy EURUSD","restore tools and add RSI"])("rejects compound or negated requests: %s",text=>expect(parseStudyRequest(text)).toHaveProperty("error"));
  it("changes only presentation; repeated commands preserve exact choices and never save",()=>{
    const f=focusedFixture();const chosen=[{...studyDefinition("rsi").defaults,id:"mine",period:21,lineStyles:[{visible:false}]}];const c={...f.context(),studies:chosen};
    expect(executeStudyRequest({action:"simplify"},c)).toContain("temporarily hidden");
    expect(f.adapter.isAnalysisFocused()).toBe(true);expect(f.notify).toHaveBeenLastCalledWith(true);
    expect(executeStudyRequest({action:"restore"},c)).toContain("Individually hidden tools stay hidden");
    expect(f.adapter.isAnalysisFocused()).toBe(false);expect(f.adapter.setStudies).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();expect(c.studies).toEqual(chosen);
  });
  it("a valid show restores, but invalid settings and unavailable evidence do not",()=>{
    const f=focusedFixture();executeStudyRequest({action:"simplify"},f.context());
    expect(executeStudyRequest(parseStudyRequest("add RSI 0")!,f.context())).toMatch(/not changed/i);expect(f.adapter.isAnalysisFocused()).toBe(true);
    expect(executeStudyRequest(parseStudyRequest("show VWAP")!,f.context())).toContain("not changed");expect(f.adapter.isAnalysisFocused()).toBe(true);
    expect(executeStudyRequest(parseStudyRequest("show RSI")!,f.context())).toContain("Restored your chosen analysis layers");expect(f.adapter.isAnalysisFocused()).toBe(false);expect(f.studies()[0].period).toBe(14);
  });
  it("unavailable or unconfirmed renderers cannot claim simplification or restoration",()=>{
    const f=focusedFixture();expect(executeStudyRequest({action:"simplify"},{...f.context(),adapter:null})).toContain("not changed");
    f.adapter.setAnalysisFocus.mockImplementation(()=>{});expect(executeStudyRequest({action:"simplify"},f.context())).toContain("could not be verified");expect(f.notify).toHaveBeenLastCalledWith(false);expect(f.save).not.toHaveBeenCalled();
  });
  it("failed restore cannot save or claim a shown study",()=>{
    const f=focusedFixture();executeStudyRequest({action:"simplify"},f.context());f.adapter.setAnalysisFocus.mockImplementation(()=>{});
    expect(executeStudyRequest(parseStudyRequest("show RSI")!,f.context())).toContain("could not be verified");expect(f.save).not.toHaveBeenCalled();expect(f.adapter.isAnalysisFocused()).toBe(true);expect(f.adapter.setStudies).toHaveBeenLastCalledWith([]);
  });
});
