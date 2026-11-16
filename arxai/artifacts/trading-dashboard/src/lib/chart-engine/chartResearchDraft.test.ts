import { describe,it,expect,vi,afterEach } from "vitest";
import { runCausalResearchV2 } from "@workspace/domain/backtest/research";
import { createChartResearchDraft,defaultChartResearchSettings,parseChartResearchRequest,finalizeChartResearchConfig, type ChartResearchDraft } from "./chartResearchDraft";

const context={symbol:"V75",timeframe:"H1",closedThroughMs:Date.parse("2026-11-01T00:00:00Z")};
const example="Test buying when the 20 EMA crosses above the 50 EMA, with an ATR-based stop, over the last two years.";
function draft(text=example):ChartResearchDraft {
  const result=parseChartResearchRequest(text,context);
  expect(result?.kind).toBe("draft");
  if(result?.kind!=="draft") throw new Error("Expected draft");
  return result.draft;
}
afterEach(()=>vi.restoreAllMocks());
describe("bounded historical request to existing research schema",()=>{
  it("turns the complete documented phrase into editable explicit rules for the selected chart",()=>{
    const result=parseChartResearchRequest(example,context);
    expect(result?.kind).toBe("draft");if(result?.kind!=="draft")return;
    expect(result.draft).toMatchObject({symbol:"V75",timeframe:"H1",intervalMs:3600000,
      requestedWindow:{fromInclusiveMs:Date.parse("2024-11-01T00:00:00Z"),toExclusiveMs:context.closedThroughMs},
      strategy:{version:"ema-cross-atr-v1",fastPeriod:20,slowPeriod:50,atrPeriod:14,stopAtrMultiple:2,targetR:2,maxHoldingBars:100,direction:"long_only"},
      costs:{fullSpreadPriceUnits:0,adverseSlippagePerFillPriceUnits:0,feePerFillPriceUnits:0},maxEntryGapMs:0,
      partitions:{trainFraction:.6,validationFraction:.2}});
    expect(result.disclosures.join("\n")).toContain("zero-cost exploratory baseline");
    expect(result.disclosures.join("\n")).toContain("not historical broker costs");
    expect(result.disclosures.join("\n")).toContain("No test has run");
    expect(result.disclosures.join("\n")).toContain("never substitute the latest 200 bars");
  });
  it("manual and text constructions produce the same engine configuration",()=>{
    const fromText=draft();
    const manual=createChartResearchDraft(context,{
      requestedWindow:{fromInclusiveMs:Date.parse("2024-11-01T00:00:00Z"),toExclusiveMs:context.closedThroughMs},
      strategy:{version:"ema-cross-atr-v1",direction:"long_only",fastPeriod:20,slowPeriod:50,atrPeriod:14,stopAtrMultiple:2,targetR:2,maxHoldingBars:100},
      costs:{fullSpreadPriceUnits:0,feePerFillPriceUnits:0,adverseSlippagePerFillPriceUnits:0},maxEntryGapMs:0,partitions:{trainFraction:.6,validationFraction:.2},
    });
    expect(manual.kind).toBe("draft");if(manual.kind!=="draft")return;
    expect(finalizeChartResearchConfig(manual.draft,17520)).toEqual(finalizeChartResearchConfig(fromText,17520));
    expect(fromText.requestedWindow.fromInclusiveMs).toBe(Date.parse("2024-11-01T00:00:00Z"));
  });
  it("manual and language drafts produce identical real engine results and fingerprints",()=>{
    const daily={...context,timeframe:"D1"};
    const language=parseChartResearchRequest(example,daily);if(language?.kind!=="draft")throw new Error("draft");
    const manual=createChartResearchDraft(daily,defaultChartResearchSettings(language.draft.requestedWindow));if(manual.kind!=="draft")throw new Error("draft");
    const {fromInclusiveMs:from,toExclusiveMs:to}=language.draft.requestedWindow;
    const bars=Array.from({length:(to-from)/86400000},(_,i)=>{
      const open=100+8*Math.sin(i/7),close=100+8*Math.sin((i+1)/7);
      return {openTimeMs:from+i*86400000,open,high:Math.max(open,close)+1,low:Math.min(open,close)-1,close};
    });
    const input={symbol:daily.symbol,priceBasis:"BID" as const,intervalMs:86400000,asOfMs:to,source:{kind:"generated" as const,reference:"manual-language-equality-fixture"},bars};
    const a=finalizeChartResearchConfig(manual.draft,bars.length),b=finalizeChartResearchConfig(language.draft,bars.length);
    if(!a.ok || !b.ok)throw new Error("configuration");
    const manualResult=runCausalResearchV2(input,a.config),languageResult=runCausalResearchV2(input,b.config);
    expect(languageResult).toEqual(manualResult);expect(languageResult.fingerprints).toEqual(manualResult.fingerprints);
    expect(languageResult.partitions.some(partition=>partition.trades.length>0)).toBe(true);
    expect(languageResult.authority).toEqual({promotionEligible:false,brokerVerified:false,persistedExperiment:false});
  });
  it("uses supplied closed cutoff, never the wallclock or a latest200bar shortcut",()=>{
    vi.spyOn(Date,"now").mockImplementation(()=>{throw new Error("No clock permitted");});
    const value=draft();
    expect(value.requestedWindow.toExclusiveMs).toBe(context.closedThroughMs);
    expect(value.requestedWindow.toExclusiveMs-value.requestedWindow.fromInclusiveMs).toBe(730*86400000);
  });
  it("clamps leap-day calendar subtraction explicitly to the valid prior-year day",()=>{
    const result=parseChartResearchRequest(example.replace("two years","one year"),{...context,closedThroughMs:Date.parse("2024-02-29T12:00:00Z")});
    expect(result?.kind).toBe("draft");if(result?.kind!=="draft")return;
    expect(result.draft.requestedWindow.fromInclusiveMs).toBe(Date.parse("2023-02-28T12:00:00Z"));
  });
  it("supports sell-only downward cross without reversing the requested direction",()=>{
    const value=draft(example.replace("buying","selling").replace("above","below"));
    expect(value.strategy.direction).toBe("short_only");
  });
  it.each([
    example.replace("buying","selling"),example.replace("20 EMA","50 EMA"),example.replace("20 EMA","0 EMA"),
    example.replace("20 EMA","1001 EMA"),example.replace("20 EMA","20.5 EMA"),example.replace("two years","zero years"),
    example.replace("two years","0 years"),example+" Then send a live order.",example+" On EURUSD.",
    example+" Using M5.",example+" With $1000 capital.",example+" Risk 2%.",example+" Use 1 lot.",
    example.replace("ATR-based stop","support break stop"),example.replace("two years","200 bars"),
  ])("does not partly apply unsupported rules/settings: %s",text=>{
    const result=parseChartResearchRequest(text,context);
    expect(result?.kind).toBe("unsupported");expect(result).not.toHaveProperty("draft");
  });
  it.each(["garbage","MN1","1M"])("refuses unsupported selected interval %s instead of falling back",timeframe=>{
    expect(parseChartResearchRequest(example,{...context,timeframe})?.kind).toBe("unsupported");
  });
  it("leaves ordinary conversation and live-order text outside this historical-only grammar",()=>{
    expect(parseChartResearchRequest("What does RSI show?",context)).toBeNull();
    expect(parseChartResearchRequest("Buy EURUSD now",context)).toBeNull();
  });
  it("manual edits retain explicit costs and reject unknown sizing/currency fields",()=>{
    const base=draft();
    const changed=createChartResearchDraft(context,{...base,costs:{fullSpreadPriceUnits:.2,adverseSlippagePerFillPriceUnits:.03,feePerFillPriceUnits:.01}});
    expect(changed.kind).toBe("draft");if(changed.kind==="draft")expect(finalizeChartResearchConfig(changed.draft,200)).toMatchObject({ok:true,config:{costs:changed.draft.costs}});
    expect(createChartResearchDraft(context,{...base,capital:1000} as any).kind).toBe("unsupported");
    expect(createChartResearchDraft(context,{...base,strategy:{...base.strategy,quantity:1}} as any).kind).toBe("unsupported");
    expect(createChartResearchDraft(context,{...base,symbol:"EURUSD"}).kind).toBe("unsupported");
  });
  it("rejects insufficient EMA/ATR warmup and empty chronological partitions",()=>{
    const base=draft();
    expect(finalizeChartResearchConfig(base,50)).toMatchObject({ok:false,message:expect.stringContaining("Insufficient")});
    expect(finalizeChartResearchConfig({...base,partitions:{trainFraction:.001,validationFraction:.001}},100)).toMatchObject({ok:false});
    expect(finalizeChartResearchConfig(base,100001)).toMatchObject({ok:false});
  });
  it("copies edited settings so later caller mutations cannot silently change a displayed draft",()=>{
    const base=draft();const result=createChartResearchDraft(context,base);if(result.kind!=="draft")throw new Error("draft");
    base.strategy.fastPeriod=3;base.costs.fullSpreadPriceUnits=99;base.requestedWindow.fromInclusiveMs=1;
    expect(result.draft.strategy.fastPeriod).toBe(20);expect(result.draft.costs.fullSpreadPriceUnits).toBe(0);
    expect(result.draft.requestedWindow.fromInclusiveMs).toBe(Date.parse("2024-11-01T00:00:00Z"));
  });
});
