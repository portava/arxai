import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartAnalysisRenderer, studyDisplayWindow } from "./chartAnalysisRenderer";
import { StudyCalculator, STUDY_DEFAULTS } from "./chartStudies";

function fixture() {
  let range = { from: 9800, to: 10010 } as any;
  let callback: (() => void) | undefined;
  let scheduled: (() => void) | undefined;
  vi.stubGlobal("requestAnimationFrame", vi.fn((fn: () => void) => { scheduled = fn; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn(() => { scheduled = undefined; }));
  const handles: any[] = [];
  const scale = { getVisibleLogicalRange: () => range, setVisibleLogicalRange: vi.fn(), subscribeVisibleLogicalRangeChange: (fn: () => void) => { callback = fn; }, unsubscribeVisibleLogicalRangeChange: vi.fn() };
  const chart = { timeScale: () => scale, panes: () => [], removeSeries: vi.fn(), addSeries: vi.fn(() => {
    const line = { setData: vi.fn(), update: vi.fn(), createPriceLine: vi.fn() };
    handles.push(line); return line;
  }) };
  const renderer = new ChartAnalysisRenderer(chart as any, {} as any);
  const candles = Array.from({ length: 10000 }, (_, i) => ({ time: 100 + i * 60, open: 100, high: 120, low: 90, close: 100 + Math.sin(i / 4) }));
  return { renderer, candles, handles, chart, scale, frame: () => scheduled?.(), move: (from: number, to: number) => { range = { from, to }; callback?.(); } };
}
afterEach(() => vi.unstubAllGlobals());
describe("study viewport rendering and streaming", () => {
  it("retains full calculations while limiting render geometry, and restores exact past values on pan", () => {
    const { renderer, handles, candles, move } = fixture();
    renderer.setStudies(STUDY_DEFAULTS.slice(0, 1), candles);
    expect(handles[0].setData.mock.calls[0][0]).toHaveLength(400);
    const historical = renderer.inspect(candles[1000]!.time)[0]!.values[0]!.value;
    expect(historical).toBeCloseTo(candles.slice(981, 1001).reduce((sum, bar) => sum + bar.close, 0) / 20, 9);
    move(1000, 1100);
    const data = handles[0].setData.mock.calls.at(-1)[0];
    expect(data[0].time).toBe(candles[800]!.time);
    expect(data.at(-1).time).toBe(candles[1300]!.time);
    expect(data.find((point: any) => point.time === candles[1000]!.time).value).toBeCloseTo(historical!, 10);
    move(1020, 1120);
    expect(handles[0].setData).toHaveBeenCalledTimes(2); // pan stays inside buffer
    move(0, 9999);
    expect(handles[0].setData.mock.calls.at(-1)[0]).toHaveLength(10000);
  });
  it("coalesces a stream burst but preserves every appended bar and the final revision", () => {
    const { renderer, handles, candles, frame } = fixture();
    const config = { ...STUDY_DEFAULTS[1]!, period: 3 };
    renderer.setStudies([config], candles);
    for (let i = 0; i < 10; i++) {
      candles[candles.length - 1] = { ...candles.at(-1)!, close: 105 + i / 10 };
      renderer.refreshLater(candles, candles.length - 1);
    }
    candles.push({ ...candles.at(-1)!, time: candles.at(-1)!.time + 60, close: 106 });
    renderer.refreshLater(candles, candles.length - 1);
    candles.push({ ...candles.at(-1)!, time: candles.at(-1)!.time + 60, close: 107 });
    renderer.refreshLater(candles, candles.length - 1);
    expect(handles[0].update).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    frame();
    const expected = new StudyCalculator(config).calculate(candles);
    for (let i = 9999; i < candles.length; i++) expect(renderer.inspect(candles[i]!.time)[0]!.values[0]!.value).toBeCloseTo(expected[i]!.values[0]!, 10);
    const visible = handles[0].setData.mock.calls.at(-1)[0];
    expect(visible.at(-1).time).toBe(candles.at(-1)!.time);
    expect(visible.at(-2).time).toBe(candles.at(-2)!.time);
  });
  it("updates historical calculations without pushing unseen streaming points into a past viewport", () => {
    const { renderer, handles, candles, frame, move } = fixture();
    renderer.setStudies(STUDY_DEFAULTS.slice(0, 1), candles);
    move(1000, 1100);
    candles[candles.length - 1] = { ...candles.at(-1)!, close: 109 };
    renderer.refreshLater(candles, 9999); frame();
    expect(handles[0].update).not.toHaveBeenCalled();
    move(9800, 10010);
    expect(handles[0].setData.mock.calls.at(-1)[0].at(-1).value).toBeCloseTo(renderer.inspect(candles.at(-1)!.time)[0]!.values[0]!.value!, 10);
  });
  it("cancels queued work when destroyed and rebuilds corrected snapshots", () => {
    const { renderer, handles, candles, frame, scale } = fixture();
    renderer.setStudies(STUDY_DEFAULTS.slice(0, 1), candles);
    renderer.refreshLater(candles, 9999);
    const corrected = candles.slice(-500).map(bar => ({ ...bar, close: 111 }));
    renderer.refresh(corrected, 0, true); frame();
    expect(renderer.inspect(corrected.at(-1)!.time)[0]!.values[0]!.value).toBe(111);
    renderer.refreshLater(corrected, 499);
    renderer.destroy(); frame();
    expect(handles[0].update).not.toHaveBeenCalled();
    expect(scale.unsubscribeVisibleLogicalRangeChange).toHaveBeenCalledTimes(1);
  });
  it("batches intermediate price-axis movement and renders only the final study window", () => {
    const {renderer,handles,candles,move}=fixture();
    renderer.setStudies(STUDY_DEFAULTS.slice(0,1),candles);
    handles[0].setData.mockClear();
    renderer.batchViewport(()=>{
      move(0,10);move(4000,4100);
      renderer.refresh(candles,9999,true);
    });
    expect(handles[0].setData).toHaveBeenCalledTimes(1);
    const rendered=handles[0].setData.mock.calls[0][0];
    expect(rendered[0].time).toBe(candles[3800]!.time);
    expect(rendered.at(-1).time).toBe(candles[4300]!.time);
    move(9000,9100);expect(handles[0].setData).toHaveBeenCalledTimes(2);
  });
  it("bounds windows at empty, first, last and out-of-range views", () => {
    expect(studyDisplayWindow(0, null, null)).toEqual({ from: 0, to: 0 });
    expect(studyDisplayWindow(10000, { from: -100, to: 100 } as any, null)).toEqual({ from: 0, to: 301 });
    expect(studyDisplayWindow(10000, { from: 9900, to: 11000 } as any, null)).toEqual({ from: 9700, to: 10000 });
    expect(studyDisplayWindow(10, null, null)).toEqual({ from: 0, to: 10 });
  });
});
