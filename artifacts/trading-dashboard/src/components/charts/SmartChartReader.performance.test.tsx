import { Profiler } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SmartChartReader } from "./SmartChartReader";
import { analyzeSmartChart } from "@/lib/chart-engine/smartChartAnalysis";
import type { ChartCandlesResponse } from "@workspace/api-client-react";
import type { ChartEngineAdapter } from "@/lib/chart-engine";

vi.mock("@/lib/chart-engine/smartChartAnalysis", async original => {
  const real = await original<typeof import("@/lib/chart-engine/smartChartAnalysis")>();
  return { ...real, analyzeSmartChart: vi.fn(real.analyzeSmartChart) };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Opt-in measurement, not a wall-clock CI gate. These are constructed inputs
// exercising the real analysis, not evidence of an actual provider capture.
it.skipIf(process.env.ARX_READER_BENCHMARK !== "1").each([200, 600])("reader notification cost for %i constructed bars", count => {
  const start = Date.parse("2026-10-25T10:00:00Z"), step = 300_000;
  vi.spyOn(Date, "now").mockReturnValue(start + (count + 2) * step);
  vi.mocked(analyzeSmartChart).mockClear();
  const candles = Array.from({ length: count }, (_, i) => {
    const open = 100 + Math.sin(i / 4) + i / 100, close = open + Math.sin(i / 3) / 4;
    return { symbol: "V75", timeframe: "M5", source: "constructed_benchmark", sourceMode: "live", qualityFlags: [],
      openTime: new Date(start + i * step).toISOString(), closeTime: new Date(start + (i + 1) * step).toISOString(),
      open, close, high: Math.max(open, close) + .5, low: Math.min(open, close) - .5,
      isComplete: true, isFinal: true, isForming: false };
  });
  const data = { symbol: "V75", timeframe: "M5", source: "constructed_benchmark", quality: "clean", candles,
    feedStatus: { source: "constructed_benchmark" }, marketEvidence: { symbol: "V75", timeframe: "M5", source: "constructed_benchmark", sourceIdentity: "a".repeat(64), lastClosedCandleAt: candles.at(-1)!.closeTime } } as unknown as ChartCandlesResponse;
  const all = candles.map(c => ({ time: Date.parse(c.openTime) / 1000, open: c.open, high: c.high, low: c.low, close: c.close }));
  let visible = all, notify = () => {}, commits = 0;
  const adapter = { getVisibleCandles: () => visible, subscribeViewport: (fn: () => void) => { notify = fn; return () => {}; }, setSmartAnnotation: vi.fn() } as unknown as ChartEngineAdapter;
  const mountStart = performance.now();
  const view = render(<Profiler id="reader" onRender={() => { commits++; }}><SmartChartReader adapter={adapter} epoch={1} symbol="V75" timeframe="M5" data={data} older={[]} historyEvidence={null} liveConfirmed readFailed={false} /></Profiler>);
  const mountMs = performance.now() - mountStart;
  expect(view.getByTestId("smart-chart-reader").getAttribute("data-analysis-status")).toBe("ready");
  // Match executed analyzer/React work before timing both variants. Without
  // this warmup the old path executes 60 analyses while the cache executes none,
  // making the subsequent changed-window control a different JIT state.
  const warmup = process.env.ARX_READER_BENCHMARK_WARMUP === "1";
  if (warmup) {
    for (let i = 0; i < 80; i++) { visible = i % 2 ? all : all.slice(1); act(notify); }
    visible = all; act(notify);
  }
  const initialCalls = vi.mocked(analyzeSmartChart).mock.calls.length, initialCommits = commits;
  const times: number[] = [];
  for (let i = 0; i < 60; i++) {
    // Real viewport notifications may return fresh array and object identities.
    visible = all.map(bar => ({ ...bar }));
    const at = performance.now(); act(notify); times.push(performance.now() - at);
  }
  const calls = vi.mocked(analyzeSmartChart).mock.calls.length - initialCalls, updates = commits - initialCommits;
  const changedAt = performance.now();
  const changedSamples: number[] = [];
  for (let i = 1; i <= 10; i++) { visible = all.slice(i); const at = performance.now(); act(notify); changedSamples.push(performance.now() - at); }
  const changedMs = performance.now() - changedAt;
  expect(vi.mocked(analyzeSmartChart).mock.calls.length - initialCalls - calls).toBe(10);
  expect(view.getByText(new RegExp(`${count - 10} closed candles analyzed`))).toBeTruthy();
  const sorted = [...times].sort((a, b) => a - b);
  console.log("ARX_READER_BENCHMARK " + JSON.stringify({ count, warmup, mountMs, samples: times, medianMs: sorted[30], p95Ms: sorted[56], maxMs: sorted.at(-1), analysisCalls: calls, reactCommits: updates, changedControl: { calls: 10, elapsedMs: changedMs, samples: changedSamples }, scope: "Constructed source-shaped input, real detectors, React development/jsdom; not browser paint or provider acceptance." }));
});
