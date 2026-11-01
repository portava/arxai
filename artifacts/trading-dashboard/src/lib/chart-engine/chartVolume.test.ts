import { describe,it,expect } from "vitest";
import { adaptChartCandles } from "@/components/scanner/scannerCandleAdapter";
import { StudyCalculator, STUDY_CATALOG, formatStudyNumber } from "./chartStudies";
import { sameCandle, incrementalCandles } from "./candleReconciliation";
const bar={time:1700000000,open:100,high:102,low:99,close:101};
const evidence=(quantity:number)=>({kind:"tick_count",quantity,unit:"ticks",reason:null});
const config={kind:"tick_volume",period:1,color:"#38bdf8"} as any;
const value=(volumeEvidence:unknown)=>new StudyCalculator(config).calculate([{...bar,volumeEvidence} as any])[0]!.values[0];
describe("source-qualified tick volume through existing study engine",()=>{
  it("keeps exact counts in the shared chart data-window and assistant formatter",()=>{
    expect(formatStudyNumber(123456789,"Ticks")).toBe("123456789");
    expect(formatStudyNumber(123456789,"Ticks (hidden)")).toBe("123456789");
  });
  it("offers an actual tick-volume study, explicitly not traded size",()=>{
    const definition=STUDY_CATALOG.find(d=>d.defaults.kind as string === "tick_volume");
    expect(definition?.description).toContain("not traded size"); expect(definition?.pane).toBe(true);
  });
  it("plots observed zero and positive integer ticks without a warmup fiction",()=>{
    expect(value(evidence(0))).toBe(0); expect(value(evidence(53))).toBe(53);
  });
  it.each([undefined,{volume:5},evidence(-1),evidence(2.5),evidence(Infinity),{...evidence(4),unit:"broker_units"},{kind:"real_volume",quantity:4,unit:"broker_units",reason:null},{...evidence(4),reason:"unverified"}])("leaves absent/malformed/other-unit volume as a gap: %j",input=>{expect(value(input)).toBeNull();});
  it("forwards only explicit qualified source evidence through the scanner adapter",()=>{
    const raw={...bar,time:bar.time*1000,source:"mt5_broker",volumeEvidence:evidence(5)};
    expect((adaptChartCandles([raw])[0] as any).volumeEvidence).toEqual(evidence(5));
    for(const source of [undefined,"synthetic_mock","deriv_public"]) expect((adaptChartCandles([{...raw,source}])[0] as any).volumeEvidence).toBeUndefined();
    expect((adaptChartCandles([{...raw,volumeEvidence:undefined,volume:500,tickVolume:500}])[0] as any).volumeEvidence).toBeUndefined();
  });
  it("detects evidence-only revisions and withdrawal despite unchanged price",()=>{
    const first={...bar,volumeEvidence:evidence(3)},second={...bar,volumeEvidence:evidence(5)};
    expect(sameCandle(first as any,second as any)).toBe(false);
    expect(incrementalCandles([first as any],[second as any])).toEqual([second]);
    expect(sameCandle(first as any,bar)).toBe(false);
  });
});
