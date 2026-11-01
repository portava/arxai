import { analyzeSmartChart, selectSmartChartWindow, type SmartChartAnalysisInput, type SmartChartSelectedWindow } from "./smartChartAnalysis";
import { describeSmartChartWindow } from "./chartDescriptiveAnalysis";

type Reading = { result: ReturnType<typeof analyzeSmartChart>; description: ReturnType<typeof describeSmartChartWindow> };
type Entry = { scope: string; window: SmartChartSelectedWindow; reading: Reading };

/** One bounded ready result per reader. Every call revalidates the entire input
 * at its current observation time before considering reuse. Never memoize by
 * array identity or bypass source/finality checks on a cache hit. */
export function createSmartChartReadCache() {
  let previous: Entry | null = null;
  return (input: SmartChartAnalysisInput): Reading => {
    const window = selectSmartChartWindow(input);
    const scope = JSON.stringify([input.dataState ?? null, input.feedReadFailed === true, input.replayCutoff ?? null, !!input.visibleRange]);
    if (window.status === "ready" && previous?.scope === scope && sameWindow(previous.window, window)) return previous.reading;
    // Invalid evidence withdraws the old result immediately; a later recovery
    // must calculate a new reading even when it happens to match the old one.
    previous = null;
    const reading = { result: analyzeSmartChart(input), description: describeSmartChartWindow(input) };
    if (window.status === "ready" && reading.result.status === "ready" && reading.description.status === "ready") {
      previous = { scope, reading, window: { ...window, coverage: { ...window.coverage }, bars: window.bars.map(bar => ({ ...bar })) } };
    }
    return reading;
  };
}

function sameWindow(a: SmartChartSelectedWindow, b: SmartChartSelectedWindow) {
  return a.contextKey === b.contextKey && a.asOf === b.asOf
    && a.coverage.available === b.coverage.available && a.coverage.analyzed === b.coverage.analyzed
    && a.coverage.truncated === b.coverage.truncated && a.coverage.note === b.coverage.note
    && a.bars.length === b.bars.length && a.bars.every((bar, i) => {
      const other = b.bars[i]!;
      return bar.time === other.time && bar.closeTime === other.closeTime
        && bar.open === other.open && bar.high === other.high && bar.low === other.low && bar.close === other.close
        && bar.isComplete === other.isComplete && bar.isFinal === other.isFinal && bar.isForming === other.isForming;
    });
}
