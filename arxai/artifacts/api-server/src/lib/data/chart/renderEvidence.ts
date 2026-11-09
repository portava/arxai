// Renderer evidence: the measured "Render Accuracy" check.
//
// Owner ruling 2026-11-09: every chart read, drawing and prediction must be
// accurate. Eleanor's VERIFIED basis therefore keeps requiring the full chart
// handshake, renderer included — and the renderer is now MEASURED instead of
// always "unavailable".
//
// Where the measurement comes from: the dashboard's chart engine adapter, after
// it draws a series, reads back what the engine actually holds and compares it
// bar for bar with the source candles (time, open, high, low, close), counts
// bars it had to drop as invalid, and checks that price→pixel→price and
// time→pixel→time round-trip on the newest bar (so a drawing anchored at a
// price/time lands there). It posts that report here.
//
// What the server accepts (fail-closed, never inferred):
//   - only for the posting user, the same symbol and timeframe;
//   - only when the report names the SAME source the server is serving and its
//     newest bar is within one interval of the server's newest bar (a report
//     about another series, or an old window, does not count);
//   - only while fresh (RENDER_EVIDENCE_TTL_MS from receipt, server clock);
//   - a transformed display (Heikin Ashi) is not a price-faithful render, so it
//     stays "unavailable" — never a pass.
// A bound report with any mismatch, dropped bar or failed round-trip is a
// measured FAIL (score 0), which fails the handshake outright.
//
// Storage is per-process memory: evidence is seconds-lived and re-posted on
// every redraw, so a restart only means "unmeasured" until the next draw.

import { timeframeMs, type ChartTimeframe } from "./timeframes.js";
import { withSubMetric } from "./chartTruthScore.js";
import type { ChartIntelligenceState } from "./chartIntelligence.js";

export const RENDER_EVIDENCE_TTL_MS = 120_000;
const MAX_ENTRIES = 5_000;

export type RenderDisplayMode = "ohlc" | "close" | "hollow" | "heikinAshi";

export interface RenderEvidenceReport {
  symbol: string;
  timeframe: ChartTimeframe;
  /** Source id the chart drew (the history source the client loaded). */
  source: string;
  displayMode: RenderDisplayMode;
  /** Newest drawn bar open time, Unix seconds. */
  newestBarTime: number;
  /** Bars the engine was given after sanitising. */
  barsCompared: number;
  /** Drawn bars whose time/OHLC differ from the source bar. */
  mismatchedBars: number;
  /** Source bars the engine refused/dropped (invalid) or did not draw. */
  droppedBars: number;
  /** price→pixel→price on the newest bar's O/H/L/C within one price step. */
  priceRoundTripOk: boolean;
  /** time→pixel→time on the newest visible bar maps back to the same bar;
   * null when no bar is on screen (not measured, not a failure). */
  timeRoundTripOk: boolean | null;
}

interface Stored extends RenderEvidenceReport { userId: number; receivedAt: number }

const store = new Map<string, Stored>();
const keyOf = (userId: number, symbol: string, timeframe: string) =>
  `${userId}|${symbol.trim().toUpperCase()}|${timeframe}`;

export function recordRenderEvidence(userId: number, report: RenderEvidenceReport, now = Date.now()): void {
  const key = keyOf(userId, report.symbol, report.timeframe);
  store.delete(key);
  if (store.size >= MAX_ENTRIES) {
    for (const [k, v] of store) {
      if (now - v.receivedAt > RENDER_EVIDENCE_TTL_MS || store.size >= MAX_ENTRIES) store.delete(k);
      if (store.size < MAX_ENTRIES) break;
    }
  }
  store.set(key, { ...report, symbol: report.symbol.trim().toUpperCase(), userId, receivedAt: now });
}

export function __clearRenderEvidenceForTests(): void { store.clear(); }

export type RenderEvidenceVerdict =
  | { status: "absent"; detail: string }
  | { status: "unbound"; detail: string }
  | { status: "unavailable"; detail: string }
  | { status: "measured"; score: number; detail: string };

/** Judge this user's latest renderer report against the series served now. */
export function judgeRenderEvidence(
  userId: number,
  state: Pick<ChartIntelligenceState, "symbol" | "timeframe" | "truthState" | "currentCandle" | "latestClosedCandle">,
  now = Date.now(),
): RenderEvidenceVerdict {
  const e = store.get(keyOf(userId, state.symbol, state.timeframe));
  if (!e) return { status: "absent", detail: "Renderer evidence unavailable: the chart has not reported a measured draw." };
  if (now - e.receivedAt > RENDER_EVIDENCE_TTL_MS) {
    return { status: "absent", detail: "Renderer evidence expired: the chart has not re-measured recently." };
  }
  const servedSource = state.truthState?.source ?? null;
  if (!servedSource || e.source !== servedSource) {
    return { status: "unbound", detail: "Renderer evidence is for a different source than the series served now." };
  }
  const newest = state.currentCandle ?? state.latestClosedCandle;
  const servedNewestSec = newest ? Date.parse(newest.openTime) / 1000 : NaN;
  const intervalSec = timeframeMs(state.timeframe) / 1000;
  if (!Number.isFinite(servedNewestSec) || Math.abs(e.newestBarTime - servedNewestSec) > intervalSec) {
    return { status: "unbound", detail: "Renderer evidence is for a different bar window than the series served now." };
  }
  if (e.displayMode === "heikinAshi") {
    return { status: "unavailable", detail: "Heikin Ashi transforms prices; render accuracy is measured on source-price styles only." };
  }
  if (e.barsCompared < 1) return { status: "unavailable", detail: "Renderer reported no drawn bars." };
  const problems = [
    e.mismatchedBars > 0 ? `${e.mismatchedBars} drawn bar(s) differ from the source` : null,
    e.droppedBars > 0 ? `${e.droppedBars} source bar(s) not drawn` : null,
    !e.priceRoundTripOk ? "price axis does not map back to the drawn price" : null,
    e.timeRoundTripOk === false ? "time axis does not map back to the drawn bar" : null,
  ].filter((p): p is string => p != null);
  if (problems.length) return { status: "measured", score: 0, detail: `Renderer mismatch: ${problems.join("; ")}.` };
  return {
    status: "measured", score: 100,
    detail: `Renderer measured: ${e.barsCompared} drawn bar(s) match the source exactly; price${e.timeRoundTripOk ? " and time" : ""} axis round-trips.`,
  };
}

/** Apply the user's renderer evidence to a state's Render Accuracy check.
 * Absent/unbound/unavailable evidence leaves it unmeasured (with the reason). */
export function applyRenderEvidence<T extends ChartIntelligenceState>(state: T, userId: number, now = Date.now()): T {
  const verdict = judgeRenderEvidence(userId, state, now);
  const raw = verdict.status === "measured" ? verdict.score : null;
  return { ...state, chartTruthScore: withSubMetric(state.chartTruthScore, "render_accuracy", raw, verdict.detail) };
}
