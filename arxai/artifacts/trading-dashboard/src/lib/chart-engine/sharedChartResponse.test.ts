import { describe, expect, it } from "vitest";
import { sharedChartResponse } from "./sharedChartResponse";
import { captureChartReplay } from "./chartReplay";
import { validatePreferences } from "./chartWorkspace";
const response = () => ({ symbol:"EURUSD", timeframe:"M15", quality:"clean", aiUsable:true,
  feedStatus:{source:"mt5_broker"}, marketEvidence:{symbol:"EURUSD",timeframe:"M15",source:"mt5_broker",sourceIdentity:"a".repeat(64),lastClosedCandleAt:"2026-01-01T00:15:00Z"},
  candles:[{symbol:"EURUSD",timeframe:"M15",source:"mt5_broker",openTime:"2026-01-01T00:00:00Z",open:1,high:2,low:0.5,close:1.5}] });
describe("Scanner to Smart Chart original-response boundary",()=>{
  it("keeps the original object and missing finality unchanged; replay still refuses it",()=>{
    const input=response(); const decoded=sharedChartResponse(input,"EURUSD","M15");
    expect(decoded).toBe(input); expect(decoded?.candles[0]).not.toHaveProperty("isFinal");
    expect(captureChartReplay(decoded,1,validatePreferences(null)).error).toContain("unambiguous closed candles");
  });
  it("preserves contradictory source evidence for downstream rejection rather than repairing it",()=>{
    const input=response();input.marketEvidence.sourceIdentity="invalid";
    const decoded=sharedChartResponse(input,"EURUSD","M15");
    expect(decoded?.marketEvidence?.sourceIdentity).toBe("invalid");
    expect(captureChartReplay(decoded,1,validatePreferences(null)).error).toContain("source-identified");
  });
  it.each([null,[],{candles:[]},{...response(),symbol:"GBPUSD"},{...response(),timeframe:"M5"},
    {...response(),candles:[{...response().candles[0],source:"deriv_public"}]},
    {...response(),candles:[{...response().candles[0],timeframe:"M5"}]},
    {...response(),candles:[{...response().candles[0],close:NaN}]},
    {...response(),candles:[{...response().candles[0],openTime:"not a timestamp"}]},
    {...response(),feedStatus:null}])("refuses malformed or foreign display context %#",input=>{
      expect(sharedChartResponse(input,"EURUSD","M15")).toBeUndefined();
  });
});
