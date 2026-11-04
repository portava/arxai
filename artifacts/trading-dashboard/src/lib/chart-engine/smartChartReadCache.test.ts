import { describe, expect, it } from "vitest";
import { createSmartChartReadCache } from "./smartChartReadCache";
import { analyzeSmartChart, type SmartChartAnalysisInput } from "./smartChartAnalysis";
import { describeSmartChartWindow } from "./chartDescriptiveAnalysis";

function input(count = 30): SmartChartAnalysisInput {
  const start = 1_790_000_000, step = 300;
  const bars = Array.from({ length: count }, (_, i) => ({ time: start + i * step, closeTime: start + (i + 1) * step,
    open: 100 + i / 100, close: 100 + i / 100 + .1, high: 102 + i / 100, low: 99 + i / 100,
    isComplete: true, isFinal: true, isForming: false }));
  return { symbol: "V75", timeframe: "M5", source: "constructed_test", sourceIdentity: "a".repeat(64), bars,
    asOfMs: (bars.at(-1)!.closeTime + 600) * 1000, dataState: "current", visibleRange: { from: bars[0]!.time, to: bars.at(-1)!.time } };
}
function oracle(value: SmartChartAnalysisInput) {
  return { result: analyzeSmartChart(value), description: describeSmartChartWindow(value) };
}

describe("ready reader cache after fresh validation", () => {
  it("reuses identical valid closed selections across array identities and advancing time", () => {
    const read = createSmartChartReadCache(), value = input(), first = read(value);
    expect(first).toEqual(oracle(value));
    const next = { ...value, bars: value.bars.map(bar => ({ ...bar })), asOfMs: value.asOfMs + 1_000 };
    expect(read(next)).toBe(first);
  });
  it("snapshots interior OHLC rather than trusting unchanged array or object identity", () => {
    const read = createSmartChartReadCache(), value = input(), first = read(value);
    value.bars[10]!.close += .2;
    const next = read(value);
    expect(next).not.toBe(first); expect(next).toEqual(oracle(value));
  });
  it("revalidates time before a hit, withdraws a future-close reading and recalculates on recovery", () => {
    const read = createSmartChartReadCache(), value = input(), first = read(value);
    const rollback = { ...value, asOfMs: value.bars.at(-1)!.closeTime * 1000 - 1 };
    const held = read(rollback);
    expect(held).toEqual(oracle(rollback)); expect(held.result.status).toBe("unavailable");
    expect(held.result.allFindings).toEqual([]);
    expect(read(value)).not.toBe(first);
    expect(read({ ...value, asOfMs: NaN }).result.status).toBe("unavailable");
  });
  it("does not retain unavailable outcomes while time advances", () => {
    const read = createSmartChartReadCache(), value = input();
    expect(read({ ...value, asOfMs: value.bars.at(-1)!.closeTime * 1000 - 1 }).result.status).toBe("unavailable");
    expect(read(value).result.status).toBe("ready");
  });
  it.each(["source", "sourceIdentity", "symbol", "dataState"] as const)("invalidates a changed %s", key => {
    const read = createSmartChartReadCache(), value = input(), first = read(value);
    const next = { ...value, [key]: key === "sourceIdentity" ? "b".repeat(64) : key === "dataState" ? "stale" : "different" } as SmartChartAnalysisInput;
    expect(read(next)).not.toBe(first); expect(read(next)).toEqual(oracle(next));
  });
  it("withdraws corrupt source evidence, wrong intervals and changed finality", () => {
    const read = createSmartChartReadCache(), value = input(); read(value);
    for (const next of [{ ...value, sourceIdentity: null }, { ...value, timeframe: "M1" },
      { ...value, bars: value.bars.map((bar, i) => i === 10 ? { ...bar, isFinal: false } : bar) }]) {
      expect(read(next).result.status).toBe("unavailable"); expect(read(next)).toEqual(oracle(next));
    }
  });
  it("checks invalid bars before the visible range even when the selected bars did not change", () => {
    const read = createSmartChartReadCache(), value = input(); value.visibleRange!.from = value.bars[10]!.time;
    read(value); value.bars[0]!.high = -1;
    expect(read(value).result.status).toBe("unavailable");
  });
  it("reuses a closed reading while only an unconfirmed forming tip changes", () => {
    const read = createSmartChartReadCache(), value = input(), first = read(value), last = value.bars.at(-1)!;
    const tip = { ...last, time: last.closeTime, closeTime: last.closeTime + 300, isComplete: false, isFinal: false, isForming: true };
    const next = { ...value, bars: [...value.bars, tip], visibleRange: { from: value.visibleRange!.from, to: tip.time } };
    expect(read(next)).toBe(first); tip.close += .3;
    expect(read(next)).toBe(first); expect(read(next)).toEqual(oracle(next));
    tip.isComplete = true; tip.isFinal = true; tip.isForming = false;
    expect(read(next)).not.toBe(first); expect(read(next).result.closedBarsUsed).toBe(31);
  });
  it("preserves truncated coverage when earlier valid bars change outside the 600-bar analysis cap", () => {
    const read = createSmartChartReadCache(), value = input(601), first = read(value);
    const next = { ...value, bars: value.bars.slice(1) };
    expect(first.result.coverage.available).toBe(601);
    expect(read(next)).not.toBe(first); expect(read(next).result.coverage.truncated).toBe(false);
  });
  it("keeps replay cutoffs and historical caveats distinct", () => {
    const read = createSmartChartReadCache(), value = input(), first = read(value);
    const replay = { ...value, replayCutoff: value.bars[19]!.closeTime, dataState: "historical" as const };
    expect(read(replay)).not.toBe(first); expect(read(replay)).toEqual(oracle(replay));
    expect(read(replay).result.closedBarsUsed).toBe(20);
    const noRange = { ...value, visibleRange: undefined };
    expect(read(noRange)).toEqual(oracle(noRange));
  });
});
