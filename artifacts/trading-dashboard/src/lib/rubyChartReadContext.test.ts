import { describe, expect, it } from "vitest";
import { CHART_INTERVALS, chartIntervalDisplayId } from "./chart-engine/chartIntervals";
import { rubyChartReadContext, rubyChartReadKey, rubyChartReadPlanKey, rubyChartDraftKey } from "./rubyChartReadContext";
import { validateRubyChartRead } from "./rubyChartReadResponse";

const full = (symbol: unknown, timeframe: unknown) => ({ symbol, timeframe, gated: false, readLayer: "FULL", bias: "Bullish", liveSetupWithheld: false, canShowLiveTradeSetup: true });

describe("chart assessment market identity", () => {
  it("a plan key cannot collide with a chart-only market containing serialized values",()=>{
    const draft={side:"BUY" as const,entry:100,sl:99,tp:102};
    const market=rubyChartReadKey("EURUSD","M5"),plan=rubyChartDraftKey(draft)!;
    expect(rubyChartReadPlanKey("EURUSD","M5",draft)).not.toBe(rubyChartReadKey(market,plan));
    expect(rubyChartReadPlanKey("EURUSD","M5",null)).toBe(rubyChartReadKey("EURUSD","M5"));
    expect(rubyChartReadPlanKey(" eurusd ","5m",{...draft})).toBe(rubyChartReadPlanKey("EURUSD","M5",draft));
  });
  it.each([...CHART_INTERVALS, "W1", "MN1"] as const)("recognizes the existing display and API interval %s without resampling", interval => {
    const display = chartIntervalDisplayId(interval);
    expect(rubyChartReadKey("EURUSD", display)).toBe(rubyChartReadKey("EURUSD", interval));
    expect(rubyChartReadContext("EURUSD", display).timeframe).toBe(interval);
    expect(validateRubyChartRead(full("EURUSD", interval), { symbol: "EURUSD", timeframe: display }).gated).toBe(false);
  });

  it("preserves monthly versus minute identity and sends an unambiguous request code", () => {
    expect(rubyChartReadContext("EURUSD", "1M").timeframe).toBe("MN1");
    expect(rubyChartReadContext("EURUSD", "1m").timeframe).toBe("M1");
    expect(rubyChartReadKey("EURUSD", "1M")).not.toBe(rubyChartReadKey("EURUSD", "1m"));
    expect(() => validateRubyChartRead(full("EURUSD", "M1"), { symbol: "EURUSD", timeframe: "1M" })).toThrow(/does not match/);
  });

  it.each(["60m", "unknown", "0m", "", " "])("does not silently substitute an unsupported interval %j", interval => {
    expect(rubyChartReadContext("EURUSD", interval).timeframe).toBe(interval.trim());
    expect(() => validateRubyChartRead(full("EURUSD", "M5"), { symbol: "EURUSD", timeframe: interval })).toThrow();
    expect(() => validateRubyChartRead(full("EURUSD", interval), { symbol: "EURUSD", timeframe: interval })).toThrow();
  });

  it("preserves an explicitly refused unsupported interval without claiming an analysis", () => {
    const value = { symbol: "EURUSD", timeframe: "unknown", gated: true, readLayer: "INSUFFICIENT", headline: "Unsupported interval" };
    expect(validateRubyChartRead(value, { symbol: "EURUSD", timeframe: "unknown" })).toEqual(value);
  });

  it.each([undefined, null, 5, {}, [], "", " "])("rejects missing or malformed symbol and interval echoes %j", value => {
    expect(() => validateRubyChartRead(full(value, "M5"), { symbol: "EURUSD", timeframe: "M5" })).toThrow();
    expect(() => validateRubyChartRead(full("EURUSD", value), { symbol: "EURUSD", timeframe: "M5" })).toThrow();
  });

  it("preserves symbol suffixes and prefixes instead of guessing broker aliases", () => {
    expect(rubyChartReadKey("EURUSD.a", "M5")).not.toBe(rubyChartReadKey("EURUSD", "M5"));
    expect(rubyChartReadKey("BROKER:EURUSD", "M5")).not.toBe(rubyChartReadKey("EURUSD", "M5"));
    expect(() => validateRubyChartRead(full("EURUSD", "M5"), { symbol: "EURUSD.a", timeframe: "M5" })).toThrow();
  });

  it("retains existing logical-symbol case normalization and removes incidental outer whitespace", () => {
    expect(rubyChartReadKey(" eurusd ", "5m")).toBe(rubyChartReadKey("EURUSD", "M5"));
    expect(validateRubyChartRead(full("EURUSD", "M5"), { symbol: " eurusd ", timeframe: " 5m " }).gated).toBe(false);
  });
});
