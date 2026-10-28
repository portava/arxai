import { describe, expect, it } from "vitest";
import { CHART_INTERVALS, CHART_QUICK_INTERVALS, chartIntervalSeconds, isChartInterval, restoreChartInterval, parseChartInterval, chartIntervalDisplayId } from "./chartIntervals";
import { validateChartLayout } from "./chartLayout";
import { candleAtLinkedTime } from "./chartViewLink";
import { smartChartIntervalSeconds } from "./smartChartAnalysis";

const expected = [
  ["M1",60],["M2",120],["M3",180],["M4",240],["M5",300],["M6",360],["M10",600],["M12",720],["M15",900],["M20",1200],["M30",1800],
  ["H1",3600],["H2",7200],["H3",10800],["H4",14400],["H6",21600],["H8",28800],["H12",43200],["D1",86400],
] as const;
describe("supported native-chart interval contract", () => {
  it("exposes the 19 supported fixed-duration MT5 intervals and retains seven quick controls", () => {
    expect(CHART_INTERVALS).toEqual(expected.map(([code])=>code));
    expect(CHART_QUICK_INTERVALS).toEqual(["M1","M5","M15","M30","H1","H4","D1"]);
  });
  it.each(expected)("keeps %s in saved comparison views, analysis and exact linked-candle boundaries", (code, seconds) => {
    expect(chartIntervalSeconds(code)).toBe(seconds);
    expect(smartChartIntervalSeconds(code)).toBe(seconds);
    expect(validateChartLayout({count:4,comparisons:[{timeframe:code},{timeframe:code},{timeframe:code}]}).comparisons.map(v=>v.timeframe)).toEqual([code,code,code]);
    const time=Date.parse("2026-10-19T00:00:00Z")/1000;
    const bars=[{time,open:1,high:2,low:1,close:1.5},{time:time+seconds*2,open:1,high:2,low:1,close:1.5}];
    expect(candleAtLinkedTime(bars,time+seconds-1,seconds)?.time).toBe(time);
    expect(candleAtLinkedTime(bars,time+seconds,seconds)).toBeNull();
    expect(candleAtLinkedTime(bars,time+seconds*2-1,seconds)).toBeNull();
  });
  it.each(["W1","MN1","1mo","1M","1m","M60","H24","__proto__","",undefined,null])("does not guess the duration or support for %s", code => {
    expect(isChartInterval(code)).toBe(false);expect(chartIntervalSeconds(code)).toBeNull();
  });
});

describe("unavailable saved chart contexts", () => {
  it.each(["W1", "MN1"] as const)("retains %s for primary and comparison refusal rather than silent M15 fallback", timeframe => {
    expect(restoreChartInterval(timeframe)).toBe(timeframe);
    expect(validateChartLayout({count:2,comparisons:[{timeframe}]}).comparisons[0]!.timeframe).toBe(timeframe);
  });
  it("falls back only for unrecognized saved values", () => {
    expect(restoreChartInterval("bogus")).toBe("M15");
    expect(restoreChartInterval("bogus", "H4")).toBe("H4");
  });
});

describe("Scanner/native interval vocabulary", () => {
  it("uses the existing Scanner display IDs for all nineteen supported API intervals", () => {
    expect(CHART_INTERVALS.map(chartIntervalDisplayId)).toEqual([
      "1m","2m","3m","4m","5m","6m","10m","12m","15m","20m","30m",
      "1h","2h","3h","4h","6h","8h","12h","1d",
    ]);
  });
  it.each(expected)("round-trips %s without relying on an unknown-to-M5 query fallback", code => {
    expect(parseChartInterval(code)).toBe(code);
    expect(parseChartInterval(code.toLowerCase())).toBe(code);
    expect(parseChartInterval(chartIntervalDisplayId(code))).toBe(code);
    expect(restoreChartInterval(chartIntervalDisplayId(code))).toBe(code);
  });
  it.each([["W1","1w"],["MN1","1mo"]] as const)("retains recognized unavailable %s", (code, display) => {
    expect(parseChartInterval(display)).toBe(code);
    expect(restoreChartInterval(display)).toBe(code);
    expect(chartIntervalDisplayId(code)).toBe(display);
  });
  it("keeps month and minute aliases distinct", () => {
    expect(parseChartInterval("1M")).toBe("MN1");
    expect(parseChartInterval("1m")).toBe("M1");
    expect(parseChartInterval("M1")).toBe("M1");
  });
  it.each(["M60", "H24", "bogus", "", 12, null, {}, "01m"])("does not parse %s as a supported interval", value => {
    expect(parseChartInterval(value)).toBeNull();
  });
});
