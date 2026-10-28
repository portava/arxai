import { describe, expect, it } from "vitest";
import { CHART_INTERVALS, CHART_QUICK_INTERVALS, chartIntervalSeconds, isChartInterval, restoreChartInterval } from "./chartIntervals";
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
