// Renderer evidence: the measured "Render Accuracy" check.
//
// Owner ruling 2026-11-09: every chart read, drawing and prediction must be
// accurate. Eleanor's VERIFIED basis therefore keeps requiring the full chart
// handshake, renderer included — and the renderer is now MEASURED instead of
// always "unavailable".
//
// Where the measurement comes from: the dashboard's chart engine adapter, after
// it draws a series, reads back what the engine actually holds and reports:
//   - bars: every drawn bar compared exactly with what it must hold (the
//     source candle; for Heikin Ashi, a fresh deterministic transform of the
//     source candles), and bars dropped as invalid;
//   - axes: time→pixel→time and price→pixel→price (O/H/L/C as drawn) on EVERY
//     visible bar;
//   - drawings: each drawing's painted geometry read back through the axes
//     against its stored anchors (trendlines, levels, zones, fibs, channels,
//     notes, and the engine-drawn structure/research lines);
//   - projections: each AI setup/prediction level as the engine holds it.
// It posts that report here.
//
// Projections are checked HERE against the payload the server itself issued
// (recordIssuedProjection, called by POST /me/assistant/draw-setup): a level
// that is not one this server issued to this user, for this symbol/timeframe,
// at exactly this price — or a setup drawn only partially — fails the read.
//
// What the server accepts (fail-closed, never inferred):
//   - only for the posting user, the same symbol and timeframe;
//   - only when the report names the SAME source the server is serving and its
//     newest bar is within one interval of the server's newest bar (a report
//     about another series, or an old window, does not count);
//   - only while fresh (RENDER_EVIDENCE_TTL_MS from receipt, server clock);
//   - only when at least one visible bar was round-tripped (nothing on screen
//     is "unavailable", never a pass).
// A bound report with any mismatch, dropped bar, failed round-trip, misplaced
// drawing or projection that differs from its issued payload is a measured
// FAIL (score 0), which fails the handshake outright.
//
// Keyed by the reader's feed-scope bridge as well (feedScope.ts): the chart's
// candle request and Eleanor's reads both run under the user's bound bridge,
// so a draw of one bridge's series never counts for a read served from
// another (the account-collapse shape the provenance guard forbids).
//
// Storage is per-process memory: evidence is seconds-lived and re-posted on
// every redraw, so a restart only means "unmeasured" until the next draw.

import { timeframeMs, type ChartTimeframe } from "./timeframes.js";
import { withSubMetric } from "./chartTruthScore.js";
import type { ChartIntelligenceState } from "./chartIntelligence.js";
import { currentFeedScopeBridgeSync, feedScopeCacheKey } from "../feedScope.js";

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
  /** price→pixel→price on every visible bar's drawn O/H/L/C within one price step. */
  priceRoundTripOk: boolean;
  /** time→pixel→time on every visible bar maps back to the same bar; null
   * when no bar is on screen. */
  timeRoundTripOk: boolean | null;
  /** Visible bars round-tripped on both axes. */
  visibleBarsRoundTripped: number;
  /** Drawings read back against their stored anchors. */
  drawings: { checked: number; failed: number; unplaced: number; failedIds: string[] };
  /** AI setup/prediction levels as the engine holds them. */
  projections: RenderedProjection[];
}

export interface RenderedProjection {
  previewId: string;
  symbol: string;
  timeframe: string;
  role: string;
  price: number;
  axisRoundTripOk: boolean | null;
}

// ── Issued projections (what the server actually sent) ───────────────────────
interface IssuedProjection { userId: number; symbol: string; timeframe: string; roles: Map<string, number>; keepUntil: number }
const issued = new Map<string, IssuedProjection>();
const issuedKey = (userId: number, previewId: string) => `${userId}|${previewId}`;
const normSymbol = (s: string) => s.trim().toUpperCase();

/** The price levels a drawable setup preview puts on the chart, by the role
 * the dashboard draws them under (ai-chart-commands.ts aiChartCommandsToOverlays). */
export function projectionRoles(levels: { entry: number; sl: number; tp: number; secondaryTp: number | null }): Map<string, number> {
  const { entry, sl, tp, secondaryTp } = levels;
  const roles = new Map<string, number>([
    ["entry", entry], ["sl", sl], ["tp", tp],
    ["risk-zone:min", Math.min(entry, sl)], ["risk-zone:max", Math.max(entry, sl)],
    ["reward-zone:min", Math.min(entry, tp)], ["reward-zone:max", Math.max(entry, tp)],
  ]);
  if (secondaryTp != null) roles.set("tp2", secondaryTp);
  return roles;
}

/** Record a setup preview this server issued to `userId`, so the chart's
 * drawn projection can be checked against it. Non-drawable previews (refusal,
 * no levels/side) put nothing on the chart and are not recorded. */
export function recordIssuedProjection(
  userId: number,
  preview: { previewId: string; symbol: string; timeframe: string; side: string | null;
    levels: { entry: number; sl: number; tp: number; secondaryTp: number | null } | null; expiresAt: string },
  now = Date.now(),
): void {
  if (!preview.levels || !preview.side) return;
  const exp = Date.parse(preview.expiresAt);
  // Keep the payload while it may still be drawn (expiry + one evidence TTL),
  // bounded to an hour so a far-future expiry cannot pin memory.
  const keepUntil = Math.min((Number.isFinite(exp) ? exp : now) + RENDER_EVIDENCE_TTL_MS, now + 3_600_000);
  if (issued.size >= MAX_ENTRIES) {
    for (const [k, v] of issued) { if (v.keepUntil < now || issued.size >= MAX_ENTRIES) issued.delete(k); if (issued.size < MAX_ENTRIES) break; }
  }
  issued.set(issuedKey(userId, preview.previewId), {
    userId, symbol: normSymbol(preview.symbol), timeframe: preview.timeframe, roles: projectionRoles(preview.levels), keepUntil,
  });
}

const samePrice = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/** Check every drawn projection against the payload this server issued.
 * Returns the problems (empty = every drawn level matches exactly). */
export function judgeProjections(
  userId: number, chart: { symbol: string; timeframe: string }, drawn: readonly RenderedProjection[], now = Date.now(),
): string[] {
  const problems: string[] = [];
  const byPreview = new Map<string, RenderedProjection[]>();
  for (const p of drawn) byPreview.set(p.previewId, [...(byPreview.get(p.previewId) ?? []), p]);
  for (const [previewId, lines] of byPreview) {
    const src = issued.get(issuedKey(userId, previewId));
    if (!src || src.keepUntil < now) { problems.push(`projection ${previewId} was not issued by the server for this user (or has expired)`); continue; }
    if (src.symbol !== normSymbol(chart.symbol) || src.timeframe !== chart.timeframe
      || lines.some(l => normSymbol(l.symbol) !== src.symbol || l.timeframe !== src.timeframe)) {
      problems.push(`projection ${previewId} is drawn on a different symbol/timeframe than it was issued for`); continue;
    }
    const seen = new Set<string>();
    for (const l of lines) {
      const want = src.roles.get(l.role);
      if (want == null) problems.push(`projection ${previewId} draws an unknown level "${l.role}"`);
      else if (seen.has(l.role)) problems.push(`projection ${previewId} draws "${l.role}" more than once`);
      else if (!samePrice(l.price, want)) problems.push(`projection ${previewId} "${l.role}" is drawn at ${l.price}, issued ${want}`);
      else if (l.axisRoundTripOk === false) problems.push(`projection ${previewId} "${l.role}" does not map back through the price axis`);
      seen.add(l.role);
    }
    const missing = [...src.roles.keys()].filter(r => !seen.has(r));
    if (missing.length) problems.push(`projection ${previewId} is drawn without ${missing.join(", ")}`);
  }
  return problems;
}

interface Stored extends RenderEvidenceReport { userId: number; receivedAt: number }

const store = new Map<string, Stored>();
const keyOf = (userId: number, scopeBridge: number | null, symbol: string, timeframe: string) =>
  `${userId}|${feedScopeCacheKey(scopeBridge)}|${symbol.trim().toUpperCase()}|${timeframe}`;

/** Record a report. `scopeBridge` is the request's resolved feed-scope bridge
 * (await currentFeedScopeBridge() in the route); null = the shared series. */
export function recordRenderEvidence(
  userId: number, report: RenderEvidenceReport, scopeBridge: number | null = null, now = Date.now(),
): void {
  const key = keyOf(userId, scopeBridge, report.symbol, report.timeframe);
  store.delete(key);
  if (store.size >= MAX_ENTRIES) {
    for (const [k, v] of store) {
      if (now - v.receivedAt > RENDER_EVIDENCE_TTL_MS || store.size >= MAX_ENTRIES) store.delete(k);
      if (store.size < MAX_ENTRIES) break;
    }
  }
  store.set(key, { ...report, symbol: report.symbol.trim().toUpperCase(), userId, receivedAt: now });
}

export function __clearRenderEvidenceForTests(): void { store.clear(); issued.clear(); }

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
  // The reader's bridge must already be resolved; a pending lookup is a miss.
  const scopeBridge = currentFeedScopeBridgeSync();
  if (scopeBridge === undefined) return { status: "absent", detail: "Renderer evidence unavailable: the reader's feed scope is not resolved." };
  const e = store.get(keyOf(userId, scopeBridge, state.symbol, state.timeframe));
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
  if (e.barsCompared < 1) return { status: "unavailable", detail: "Renderer reported no drawn bars." };
  const ha = e.displayMode === "heikinAshi";
  const problems = [
    e.mismatchedBars > 0 ? `${e.mismatchedBars} drawn bar(s) differ from ${ha ? "the Heikin Ashi transform of the source" : "the source"}` : null,
    e.droppedBars > 0 ? `${e.droppedBars} source bar(s) not drawn` : null,
    !e.priceRoundTripOk ? "price axis does not map back to a drawn price" : null,
    e.timeRoundTripOk === false ? "time axis does not map back to a drawn bar" : null,
    e.drawings.failed > 0 ? `${e.drawings.failed} drawing(s) not where their anchors are (${e.drawings.failedIds.slice(0, 5).join(", ")})` : null,
    ...judgeProjections(userId, state, e.projections, now),
  ].filter((p): p is string => p != null);
  if (problems.length) return { status: "measured", score: 0, detail: `Renderer mismatch: ${problems.join("; ")}.` };
  // Nothing on screen to round-trip: not a measured pass.
  if (e.visibleBarsRoundTripped < 1 || e.timeRoundTripOk !== true) {
    return { status: "unavailable", detail: "Renderer evidence has no visible bar to round-trip through the chart axes." };
  }
  const previews = new Set(e.projections.map(p => p.previewId)).size;
  return {
    status: "measured", score: 100,
    detail: `Renderer measured: ${e.barsCompared} drawn bar(s) match ${ha ? "the Heikin Ashi transform of the source" : "the source"} exactly; `
      + `${e.visibleBarsRoundTripped} visible bar(s) round-trip price and time; `
      + `${e.drawings.checked} drawing(s) read back at their anchors${e.drawings.unplaced ? ` (${e.drawings.unplaced} off screen, not measured)` : ""}; `
      + `${previews} AI projection(s) match the issued levels.`,
  };
}

/** Apply the user's renderer evidence to a state's Render Accuracy check.
 * Absent/unbound/unavailable evidence leaves it unmeasured (with the reason). */
export function applyRenderEvidence<T extends ChartIntelligenceState>(state: T, userId: number, now = Date.now()): T {
  // A state without a truth score has no Render Accuracy check to fill (and so
  // can never be VERIFIED): hand it back untouched rather than throw.
  if (!state?.chartTruthScore?.subMetrics) return state;
  const verdict = judgeRenderEvidence(userId, state, now);
  const raw = verdict.status === "measured" ? verdict.score : null;
  const chartTruthScore = withSubMetric(state.chartTruthScore, "render_accuracy", raw, verdict.detail);
  return chartTruthScore === state.chartTruthScore ? state : { ...state, chartTruthScore };
}
