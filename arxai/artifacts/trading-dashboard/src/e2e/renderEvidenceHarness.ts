// Real-browser harness for the chart render self-check
// (scripts/src/qaChartRenderBrowser.ts). Loaded only by e2e/render-evidence.html
// under the Vite dev server; never part of the production bundle.
//
// It boots the dashboard's REAL chart engine (LightweightChartsAdapter on the
// real lightweight-charts canvas in Chromium), loads a deterministic candle
// feed from the test server, draws the requested style and drawings, and lets
// the REAL reporter (renderEvidenceReporter.ts) measure and post the evidence
// to the real api-server. A run may inject one fault INTO THE ENGINE (one
// drawn bar, or one painted drawing stroke) — never into the measurement — so
// the test can prove the server records a measured FAIL.
import { LightweightChartsAdapter } from "@/lib/chart-engine/lightweightChartsAdapter";
import { reportRenderEvidence, __resetRenderEvidenceReporterForTests } from "@/lib/chart-engine/renderEvidenceReporter";
import type { ChartDrawing, ChartStyle } from "@/lib/chart-engine/chartWorkspace";
import type { ChartEngineCandle, RenderFidelity } from "@/lib/chart-engine/types";

export interface HarnessRun {
  symbol: string;
  timeframe: string;
  source: string;
  style: ChartStyle;
  drawings: ChartDrawing[];
  /** Index of one drawn bar to corrupt inside the engine (close + delta). */
  corruptBarIndex?: number;
  /** Id of one drawing whose painted stroke is moved inside the primitive. */
  corruptDrawingId?: string;
}

export interface HarnessResult {
  fidelity: RenderFidelity | null;
  bars: number;
  posted: boolean;
}

const frames = (n: number) => new Promise<void>(resolve => {
  const step = (k: number) => (k <= 0 ? resolve() : requestAnimationFrame(() => step(k - 1)));
  step(n);
});

let adapter: LightweightChartsAdapter | null = null;

async function run(cfg: HarnessRun): Promise<HarnessResult> {
  adapter?.destroy();
  __resetRenderEvidenceReporterForTests();
  const res = await fetch("/__fixture/candles.json");
  const candles = await res.json() as ChartEngineCandle[];
  const container = document.getElementById("chart")!;
  adapter = new LightweightChartsAdapter();
  adapter.init({ container, height: 480 });
  adapter.setDisplayPricePrecision(5);
  adapter.setCandles(candles);
  adapter.setChartStyle(cfg.style);
  adapter.setDrawings(cfg.drawings);
  await frames(4);

  if (cfg.corruptBarIndex != null) {
    const surface = adapter.getScannerOverlaySurface()!;
    const rows = [...(surface.series as unknown as { data(): readonly Record<string, number>[] }).data()];
    const row = { ...rows[cfg.corruptBarIndex]! };
    if ("value" in row) row["value"]! += 0.001; else row["close"]! += 0.001;
    rows[cfg.corruptBarIndex] = row;
    (surface.series as unknown as { setData(d: unknown[]): void }).setData(rows);
  }
  await frames(2);
  if (cfg.corruptDrawingId) {
    const primitive = (adapter as unknown as { analysis: { drawingPrimitive: {
      measureRender(step: number): unknown; strokes: { id: string; start: { x: number; y: number }; end: { x: number; y: number } }[];
    } } }).analysis.drawingPrimitive;
    // Settle geometry, then move the painted stroke. No frame runs between this
    // and the measurement below (a paint would rebuild the strokes).
    primitive.measureRender(1e-5);
    const stroke = primitive.strokes.find(s => s.id === cfg.corruptDrawingId);
    if (!stroke) throw new Error(`no painted stroke for ${cfg.corruptDrawingId}`);
    stroke.start = { ...stroke.start, y: stroke.start.y + 25 };
  }

  const fidelity = adapter.measureRenderFidelity();
  const posted = new Promise<boolean>(resolve => {
    reportRenderEvidence(adapter, { symbol: cfg.symbol, timeframe: cfg.timeframe, source: cfg.source }, Date.now(), () => resolve(true));
    setTimeout(() => resolve(false), 10_000);
  });
  return { fidelity, bars: candles.length, posted: await posted };
}

declare global { interface Window { __arxRenderHarness?: { run: typeof run } } }
window.__arxRenderHarness = { run };
