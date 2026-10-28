// Shadow Mode + Forward Testing + Strategy Tournament + Confidence Calibration
// + Promotion/Demotion Gates + AI Readiness Score + Shadow Journal.
//
// SAFETY:
// - Shadow decisions are observations, never orders. The OMS, simulator, and
//   broker bridges are NOT touched here.
// - dataSource is always "SHADOW". Records live in their own in-memory store
//   so they cannot mix with simulator/intent/future broker records.
// - Promotion levels max out at LIVE_INTENT_APPROVED. FUTURE_MT5_LIVE_LOCKED
//   is visible-only; never reachable until the bridge is wired.
// - Every shadow decision is checked by the one Risk Governor at platform
//   default limits (previewSimulatorEntry, pure) with the same facts the
//   simulator OMS would supply. Shadow mode never books an order.

import { marketSimulator } from "./marketSimulator.js";
import { previewSimulatorEntry } from "./oms.js";
import { runStrategyScan, type Candle as EngineCandle } from "./strategyEngine.js";
import { DEFAULT_SYMBOLS } from "./marketScanner.js";
import { resolveArxMarket } from "@workspace/domain/market";
import { buildForwardChartSeries, type ForwardChartSeries } from "./shadow/forwardChartSeries.js";
// shadowPersistence imports this module type-only, so no runtime cycle.
import {
  persistShadowDecision,
  updateShadowOutcome,
  SYNTHETIC_SIMULATOR_SOURCE,
} from "./shadowPersistence.js";
import {
  buildFeatureSnapshot,
  latestCloseIso,
  FEATURE_SET_ID,
  type FeatureSnapshot,
} from "./features/featureSnapshot.js";

function adaptCandles(symbol: string): EngineCandle[] {
  return marketSimulator.candlesFor(symbol, 240).map((c) => ({
    time: c.tsIso, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v,
  }));
}

export type ShadowStatus =
  | "SHADOW_OBSERVATION" | "SHADOW_TRADE_IDEA" | "SHADOW_WAIT" | "SHADOW_REJECTED"
  | "SHADOW_TRACKING_OUTCOME" | "SHADOW_WIN" | "SHADOW_LOSS" | "SHADOW_BREAKEVEN" | "SHADOW_EXPIRED";

export interface ShadowDecision {
  id: string; ts: string; symbol: string; tf: string; strategy: string;
  marketCondition: string; action: "BUY" | "SELL" | "WAIT"; entry: number;
  /**
   * Stop / target the strategy actually proposed. null = none proposed (a
   * WAIT with no setup) — never an invented fallback level.
   */
  sl: number | null; tp: number | null;
  confidence: number; opportunity: number; sniper: number; grade: number;
  riskGovernor: { approved: boolean; level: string; hardBlocks: string[]; warnings: string[] };
  reason: string; reasonToAvoid: string;
  status: ShadowStatus; expiresAt: string; pnlR?: number; outcomeAt?: string;
  /**
   * Set when nothing tracked (or kept tracking) this idea's outcome:
   * TRACKING_STOPPED — shadow mode was stopped while it was open (closed as
   * SHADOW_EXPIRED at outcomeAt, no R measured); TRACKER_NOT_RUNNING — it was
   * made while shadow mode was stopped (SHADOW_TRADE_IDEA, never tracked).
   */
  untrackedReason?: "TRACKING_STOPPED" | "TRACKER_NOT_RUNNING";
  dataSource: "SHADOW";
  /**
   * R7 step 4 — feature provenance. `featureSetId` pins WHICH shared-engine
   * version (lib/features FEATURE_SET_ID) ran when this decision was made;
   * `featureSnapshot` is the EXACT feature assumptions it saw (or an honest
   * INSUFFICIENT_DATA / LOOKAHEAD_REFUSED refusal), computed from the SAME
   * candles the strategy scan consumed. Both are persisted verbatim so
   * research/replay can reproduce the decision (Part IV). Optional + additive:
   * pre-R7 in-memory decisions and fixtures stay valid; absence means the
   * assumptions were never recorded — an honest UNKNOWN, never a default.
   */
  featureSetId?: string;
  featureSnapshot?: FeatureSnapshot;
}

const decisions = new Map<string, ShadowDecision>();
let shadowEnabled = false;
let shadowStartedAt: string | null = null;
let scanTimer: NodeJS.Timeout | null = null;
let trackTimer: NodeJS.Timeout | null = null;
let totalsObserved = 0;
// Creation order of every decision (monotonic). Start/Stop record it so a
// window edge is exact even when decisions share a millisecond with it.
const decisionSeq = new Map<string, number>();
let lastDecisionSeq = 0;

/** A proposed trade (BUY/SELL) the risk governor blocked. A WAIT proposes no trade and is never a block. */
function rgBlocked(d: ShadowDecision): boolean {
  return d.action !== "WAIT" && !d.riskGovernor.approved;
}

function newId() { return `sh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

function classifyMarket(symbol: string): string {
  const c = marketSimulator.candlesFor(symbol, 20);
  if (c.length < 5) return "UNKNOWN";
  const range = Math.max(...c.map((x) => x.h)) - Math.min(...c.map((x) => x.l));
  const body = Math.abs(c[c.length - 1].c - c[0].o);
  return body > range * 0.6 ? "TRENDING" : range > 0 && body / range < 0.25 ? "RANGE" : "MIXED";
}

export function createShadowDecision(symbol: string, tf = "M15"): ShadowDecision | null {
  const candles = adaptCandles(symbol);
  if (candles.length < 5) return null;
  const scan = runStrategyScan(symbol, candles, 50, "synthetic");
  if (!scan) return null;
  const q = marketSimulator.quote(symbol);
  const entry = scan.entryPrice || q?.mid || 0;
  // Only levels the strategy proposed. A WAIT with no setup reports 0 for
  // both: that is "none", not a cue to invent entry * 0.997 / 1.005.
  const proposed = (v: number) => (Number.isFinite(v) && v > 0 ? v : null);
  const sl = proposed(scan.stopLoss);
  const tp = proposed(scan.takeProfit);
  const action = scan.direction === "WAIT" ? "WAIT" : (scan.direction as "BUY" | "SELL");

  // The risk governor checks a proposed trade. A WAIT proposes none, so it is
  // NOT_CHECKED (and never counted as a risk block) instead of a preview of a
  // made-up BUY at made-up levels.
  const rg = action === "WAIT"
    ? { approved: false, riskLevel: "NOT_CHECKED", hardBlocks: [] as string[], warnings: [] as string[] }
    : (() => {
        const verdict = previewSimulatorEntry({
          symbol, side: action, lots: 0.01,
          stopLoss: sl, takeProfit: tp, aiConfidence: scan.confidence, origin: "automation",
        });
        return {
          approved: verdict.decision === "ALLOW",
          riskLevel: verdict.decision === "ALLOW" ? "LOW" : "BLOCK",
          hardBlocks: verdict.blockedBy.map(String),
          warnings: verdict.rules.map((r) => r.measured?.["warnings"]).filter((w): w is string => typeof w === "string"),
        };
      })();

  let status: ShadowStatus =
    action === "WAIT" ? "SHADOW_WAIT"
      : !rg.approved ? "SHADOW_REJECTED"
      : "SHADOW_TRACKING_OUTCOME";
  // Only the outcome tracker (running while shadow mode runs) resolves an
  // idea. With it stopped, the idea is recorded but never claimed as tracked.
  let untrackedReason: ShadowDecision["untrackedReason"];
  if (status === "SHADOW_TRACKING_OUTCOME" && !trackTimer) {
    status = "SHADOW_TRADE_IDEA";
    untrackedReason = "TRACKER_NOT_RUNNING";
  }

  // R7 step 4 — stamp the decision with the shared feature engine's snapshot,
  // computed from the SAME candles the strategy scan above consumed (never a
  // second fetch). These candles are SYNTHETIC simulator bars until the
  // real-data swap (later R7 step): the stamp records the exact assumptions
  // the decision saw — it does NOT upgrade their provenance, which stays
  // labeled SYNTHETIC_SIMULATOR_SOURCE on the persisted row. asOf anchors to
  // the newest bar's close so replaying the same bars reproduces the snapshot.
  let featureSnapshot: FeatureSnapshot | undefined;
  try {
    const featureAsOf = latestCloseIso(candles);
    if (featureAsOf !== null) {
      featureSnapshot = buildFeatureSnapshot(symbol, candles, featureAsOf);
    }
  } catch {
    // NOT a lookahead swallow: buildFeatureSnapshot already returns a typed
    // LOOKAHEAD_REFUSED refusal for LookaheadError and rethrows only
    // non-lookahead defects. A defect in this additive stamp must not break
    // the shadow scanner loop (module contract) — the decision is recorded
    // without the stamp, which reads as an honest "assumptions not recorded".
  }

  const d: ShadowDecision = {
    id: newId(), ts: new Date().toISOString(), symbol, tf, strategy: scan.strategy,
    marketCondition: classifyMarket(symbol), action, entry, sl, tp,
    confidence: scan.confidence, opportunity: scan.confidence,
    sniper: Math.max(0, scan.confidence - 5), grade: Math.round(scan.confidence / 10),
    riskGovernor: { approved: rg.approved, level: rg.riskLevel, hardBlocks: rg.hardBlocks, warnings: rg.warnings },
    reason: scan.reason, reasonToAvoid: rg.hardBlocks.join("; ") || scan.riskWarning || "",
    status, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...(untrackedReason ? { untrackedReason } : {}),
    dataSource: "SHADOW",
    featureSetId: FEATURE_SET_ID,
    featureSnapshot,
  };
  decisions.set(d.id, d);
  decisionSeq.set(d.id, ++lastDecisionSeq);
  totalsObserved++;
  // Durability is purely additive: the in-memory store stays the source of
  // truth. Candles come from marketSimulator (synthetic) until the real-data
  // swap (later R7 step), so the persisted row is labeled
  // SYNTHETIC_SIMULATOR_SOURCE — it must never read as market evidence.
  // persistShadowDecision try/catches to a warning internally; the extra
  // .catch guarantees the floating promise can never break the scanner loop.
  void persistShadowDecision(d, SYNTHETIC_SIMULATOR_SOURCE).catch(() => {});
  return d;
}

// Persistence failure must never break the scanner loop (module contract):
// updateShadowOutcome warns internally; the .catch is belt-and-braces for the
// floating promise.
function persistOutcome(d: ShadowDecision): void {
  void updateShadowOutcome(d).catch(() => {});
}

function trackOutcomes() {
  const now = Date.now();
  for (const d of decisions.values()) {
    if (d.status !== "SHADOW_TRACKING_OUTCOME") continue;
    const q = marketSimulator.quote(d.symbol);
    if (!q) continue;
    const px = q.mid;
    if (d.sl == null || d.tp == null) { d.status = "SHADOW_EXPIRED"; d.outcomeAt = new Date(now).toISOString(); persistOutcome(d); continue; }
    const r = Math.abs(d.entry - d.sl);
    if (r === 0) { d.status = "SHADOW_EXPIRED"; d.outcomeAt = new Date(now).toISOString(); persistOutcome(d); continue; }
    if (d.action === "BUY") {
      if (px <= d.sl) { d.status = "SHADOW_LOSS"; d.pnlR = -1; d.outcomeAt = new Date(now).toISOString(); }
      else if (px >= d.tp) { d.status = "SHADOW_WIN"; d.pnlR = (d.tp - d.entry) / r; d.outcomeAt = new Date(now).toISOString(); }
    } else if (d.action === "SELL") {
      if (px >= d.sl) { d.status = "SHADOW_LOSS"; d.pnlR = -1; d.outcomeAt = new Date(now).toISOString(); }
      else if (px <= d.tp) { d.status = "SHADOW_WIN"; d.pnlR = (d.entry - d.tp) / r; d.outcomeAt = new Date(now).toISOString(); }
    }
    if (d.status === "SHADOW_TRACKING_OUTCOME" && now > Date.parse(d.expiresAt)) {
      const drift = (px - d.entry) / r;
      if (Math.abs(drift) < 0.1) { d.status = "SHADOW_BREAKEVEN"; d.pnlR = 0; }
      else d.status = "SHADOW_EXPIRED";
      d.outcomeAt = new Date(now).toISOString();
    }
    // Any transition out of SHADOW_TRACKING_OUTCOME above is terminal — sync
    // the resolved outcome to the durable row (fire-and-forget, never throws).
    if (d.status !== "SHADOW_TRACKING_OUTCOME") persistOutcome(d);
  }
}

export function startShadowMode(opts?: { symbols?: string[]; intervalSec?: number }): { running: boolean; startedAt: string | null } {
  if (shadowEnabled) return { running: true, startedAt: shadowStartedAt };
  shadowEnabled = true; shadowStartedAt = new Date().toISOString();
  const symbols = opts?.symbols && opts.symbols.length ? opts.symbols : DEFAULT_SYMBOLS;
  const intervalMs = Math.max(2, opts?.intervalSec ?? 5) * 1000;
  scanTimer = setInterval(() => {
    if (!shadowEnabled) return;
    for (const s of symbols) createShadowDecision(s, "M15");
  }, intervalMs);
  scanTimer.unref?.();
  trackTimer = setInterval(trackOutcomes, 1000);
  trackTimer.unref?.();
  return { running: true, startedAt: shadowStartedAt };
}
export function stopShadowMode() {
  shadowEnabled = false;
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
  // Nothing tracks an open idea after Stop, so none may keep reading as
  // "tracking": each is closed as expired with no measured R, and says why.
  const at = new Date().toISOString();
  let closedUntracked = 0;
  for (const d of decisions.values()) {
    if (d.status !== "SHADOW_TRACKING_OUTCOME") continue;
    d.status = "SHADOW_EXPIRED"; d.outcomeAt = at; d.untrackedReason = "TRACKING_STOPPED";
    persistOutcome(d);
    closedUntracked++;
  }
  return { running: false, closedUntracked };
}
export function shadowStatus() {
  const arr = [...decisions.values()];
  return {
    enabled: shadowEnabled, startedAt: shadowStartedAt,
    totalsObserved, totalDecisions: arr.length,
    tracking: arr.filter((d) => d.status === "SHADOW_TRACKING_OUTCOME").length,
    wins: arr.filter((d) => d.status === "SHADOW_WIN").length,
    losses: arr.filter((d) => d.status === "SHADOW_LOSS").length,
    breakevens: arr.filter((d) => d.status === "SHADOW_BREAKEVEN").length,
    expired: arr.filter((d) => d.status === "SHADOW_EXPIRED").length,
    rejected: arr.filter((d) => d.status === "SHADOW_REJECTED").length,
    waits: arr.filter((d) => d.status === "SHADOW_WAIT").length,
    // Ideas whose outcome nothing tracked (stopped mid-way, or made while stopped).
    untracked: arr.filter((d) => d.untrackedReason).length,
    trackerRunning: trackTimer !== null,
    // Every candle and quote shadow mode reads comes from the built-in
    // synthetic market simulator, not a live feed or broker.
    priceSource: SYNTHETIC_SIMULATOR_SOURCE,
    dataSource: "SHADOW" as const,
  };
}
export function listDecisions(limit = 200, filter?: { strategy?: string; status?: ShadowStatus; symbol?: string }) {
  let arr = [...decisions.values()];
  if (filter?.strategy) arr = arr.filter((d) => d.strategy === filter.strategy);
  if (filter?.status) arr = arr.filter((d) => d.status === filter.status);
  if (filter?.symbol) arr = arr.filter((d) => d.symbol === filter.symbol);
  arr.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return arr.slice(0, limit);
}

// ── Forward Testing ──────────────────────────────────────────────────────
export interface ForwardTestConfig {
  strategy?: string; symbols: string[]; timeframes: string[];
  durationMin: number; maxShadowTrades: number; maxTradesPerDay: number;
  minConfidence: number; minOpportunity: number; minTradeGrade: number;
  riskProfile: string; sessionFilters: string[]; newsFilters: string[];
}
let forwardConfig: ForwardTestConfig | null = null;
// The config of the most recent forward test (running or ended), so its
// strategy filter keeps scoping results after it ends.
let forwardLastConfig: ForwardTestConfig | null = null;
let forwardStartedAt: string | null = null;
let forwardEndsAt: string | null = null;
let forwardEndedAt: string | null = null;
let forwardEndReason: "duration_elapsed" | "stopped" | null = null;
// Decision sequence at Start (window holds later ones) and at Stop (window
// holds none after it); null end = still running or ended by duration.
let forwardStartSeq = 0;
let forwardEndSeq: number | null = null;

/** Longest forward test accepted (7 days), in minutes. */
export const FORWARD_MAX_DURATION_MIN = 7 * 24 * 60;

/** A forward-test duration is a finite number of minutes in [1, FORWARD_MAX_DURATION_MIN]. */
export function isValidForwardDurationMin(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= FORWARD_MAX_DURATION_MIN;
}

/**
 * End a running forward test whose duration has elapsed. Read-time, so a
 * missed timer can never leave a test reading RUNNING past its endsAt.
 */
function settleForwardTest(now = Date.now()): void {
  if (forwardConfig && forwardEndsAt && now >= Date.parse(forwardEndsAt)) {
    forwardConfig = null;
    forwardEndedAt = forwardEndsAt;
    forwardEndReason = "duration_elapsed";
  }
}

export function startForwardTest(c: Partial<ForwardTestConfig> = {}): { running: boolean; endsAt: string } {
  if (c.durationMin !== undefined && !isValidForwardDurationMin(c.durationMin)) {
    // Refuse instead of starting a test that has already ended (0 min) or
    // whose end time cannot be computed (NaN / non-numeric).
    throw new RangeError(`durationMin must be a number of minutes from 1 to ${FORWARD_MAX_DURATION_MIN}.`);
  }
  forwardConfig = {
    strategy: c.strategy, symbols: c.symbols ?? [...DEFAULT_SYMBOLS], timeframes: c.timeframes ?? ["M15"],
    durationMin: c.durationMin ?? 60, maxShadowTrades: c.maxShadowTrades ?? 100, maxTradesPerDay: c.maxTradesPerDay ?? 30,
    minConfidence: c.minConfidence ?? 60, minOpportunity: c.minOpportunity ?? 60, minTradeGrade: c.minTradeGrade ?? 6,
    riskProfile: c.riskProfile ?? "CONSERVATIVE",
    sessionFilters: c.sessionFilters ?? [], newsFilters: c.newsFilters ?? [],
  };
  forwardLastConfig = forwardConfig;
  forwardStartedAt = new Date().toISOString();
  forwardEndsAt = new Date(Date.now() + forwardConfig.durationMin * 60_000).toISOString();
  forwardEndedAt = null;
  forwardEndReason = null;
  forwardStartSeq = lastDecisionSeq;
  forwardEndSeq = null;
  if (!shadowEnabled) startShadowMode({ symbols: forwardConfig.symbols });
  return { running: true, endsAt: forwardEndsAt };
}
export function stopForwardTest() {
  settleForwardTest();
  const c = forwardConfig;
  if (c) {
    forwardConfig = null;
    forwardEndedAt = new Date().toISOString();
    forwardEndReason = "stopped";
    forwardEndSeq = lastDecisionSeq;
  }
  return { stopped: true, was: c };
}

export function forwardStatus() {
  settleForwardTest();
  return {
    running: !!forwardConfig, startedAt: forwardStartedAt, endsAt: forwardEndsAt,
    // When the test ended (endsAt reached, or Stop) and why; null while running
    // or before any test started.
    endedAt: forwardEndedAt, endReason: forwardEndReason,
    config: forwardConfig,
    // Shadow decisions inside the test window (all strategies): frozen once
    // the test ends, 0 before any test started.
    observedSinceStart: forwardWindowDecisions(false).length,
    dataSource: "SHADOW" as const,
  };
}

/**
 * The forward test's own decisions: made at or after it started and, once it
 * ended, no later than its end — filtered to its strategy. Empty before any
 * forward test started (shadow decisions from other surfaces are not forward
 * results).
 */
function forwardWindowDecisions(byStrategy: boolean): ShadowDecision[] {
  settleForwardTest();
  if (!forwardStartedAt) return [];
  const until = forwardEndedAt ? Date.parse(forwardEndedAt) : Number.POSITIVE_INFINITY;
  const strategy = byStrategy ? (forwardConfig ?? forwardLastConfig)?.strategy : undefined;
  return [...decisions.values()].filter((d) => {
    const seq = decisionSeq.get(d.id) ?? 0;
    if (seq <= forwardStartSeq) return false;
    // Stopped: by creation order. Ended by duration: by time (settled at read).
    const inside = forwardEndSeq !== null ? seq <= forwardEndSeq : Date.parse(d.ts) <= until;
    return inside && (!strategy || d.strategy === strategy);
  });
}

export function forwardResults() {
  const arr = forwardWindowDecisions(true);
  const wins = arr.filter((d) => d.status === "SHADOW_WIN");
  const losses = arr.filter((d) => d.status === "SHADOW_LOSS");
  const tracked = wins.length + losses.length;
  const winRate = tracked ? wins.length / tracked : 0;
  const avgR = arr.filter((d) => d.pnlR != null).reduce((a, d) => a + (d.pnlR ?? 0), 0) / Math.max(1, tracked);
  const bySymbol: Record<string, { n: number; wins: number }> = {};
  const byStrategy: Record<string, { n: number; wins: number }> = {};
  for (const d of arr) {
    bySymbol[d.symbol] = bySymbol[d.symbol] ?? { n: 0, wins: 0 };
    byStrategy[d.strategy] = byStrategy[d.strategy] ?? { n: 0, wins: 0 };
    if (d.status === "SHADOW_WIN" || d.status === "SHADOW_LOSS") {
      bySymbol[d.symbol].n++; byStrategy[d.strategy].n++;
      if (d.status === "SHADOW_WIN") { bySymbol[d.symbol].wins++; byStrategy[d.strategy].wins++; }
    }
  }
  // Only entries with at least one tracked outcome (win or loss) are ranked:
  // a symbol/strategy with no outcome has no win rate, so it is never named
  // best or worst. A worst pick needs a second ranked entry (one entry is not
  // both the best and the worst).
  const ranked = (m: Record<string, { n: number; wins: number }>) =>
    Object.entries(m).filter(([, v]) => v.n > 0)
      .map(([k, v]) => ({ k, winRate: v.wins / v.n, n: v.n })).sort((a, b) => b.winRate - a.winRate);
  const symbolRank = ranked(bySymbol);
  const stratRank = ranked(byStrategy);
  const worstOf = (r: { k: string }[]) => (r.length >= 2 ? r[r.length - 1]!.k : null);
  return {
    totalShadowDecisions: arr.length,
    shadowTradesTracked: tracked,
    wins: wins.length, losses: losses.length,
    breakevens: arr.filter((d) => d.status === "SHADOW_BREAKEVEN").length,
    expired: arr.filter((d) => d.status === "SHADOW_EXPIRED").length,
    rejected: arr.filter((d) => d.status === "SHADOW_REJECTED").length,
    winRate: Number((winRate * 100).toFixed(1)),
    avgR: Number(avgR.toFixed(2)),
    maxDrawdownR: Number(maxDrawdownR(arr).toFixed(2)),
    bestSymbol: symbolRank[0]?.k ?? null, worstSymbol: worstOf(symbolRank),
    bestStrategy: stratRank[0]?.k ?? null, weakestStrategy: worstOf(stratRank),
    confidenceCalibration: confidenceCalibration().label,
    // The window these results cover (null start = no forward test has run).
    testStartedAt: forwardStartedAt,
    testEndedAt: forwardEndedAt,
    running: !!forwardConfig,
    dataSource: "SHADOW" as const,
  };
}
// Forward-test equity (R-multiple) chart series (Task #763) — DISPLAY-ONLY.
// Same scope as forwardResults(): the forward test's own window, filtered to
// its strategy. Pure derivation via buildForwardChartSeries.
export function forwardChartSeries(): ForwardChartSeries {
  const arr = forwardWindowDecisions(true);
  return buildForwardChartSeries(arr.map((d) => ({
    id: d.id, ts: d.ts, symbol: d.symbol, strategy: d.strategy,
    action: d.action, entry: d.entry, status: d.status,
    pnlR: d.pnlR, outcomeAt: d.outcomeAt,
  })));
}

function maxDrawdownR(arr: ShadowDecision[]): number {
  let peak = 0, cum = 0, dd = 0;
  for (const d of arr.filter((x) => x.pnlR != null).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    cum += d.pnlR ?? 0; if (cum > peak) peak = cum; dd = Math.min(dd, cum - peak);
  }
  return Math.abs(dd);
}

// ── Strategy Tournament ───────────────────────────────────────────────────
let tournamentStartedAt: string | null = null;
let tournamentEnabled = false;

export function startTournament(): { running: boolean } {
  tournamentEnabled = true; tournamentStartedAt = new Date().toISOString();
  if (!shadowEnabled) startShadowMode();
  return { running: true };
}

/**
 * Names the strategy engine gives a scan that is NOT a strategy's call:
 * "No Trade Filter" = no strategy had an actionable signal; "None" = too few
 * candles to run any strategy. They are never ranked, gated or demoted.
 */
const SCAN_PLACEHOLDER_NAMES = new Set(["No Trade Filter", "None"]);
export function isScanPlaceholder(strategy: string): boolean {
  return SCAN_PLACEHOLDER_NAMES.has(strategy);
}

/** Market group of the symbol a decision was actually made on. */
function marketGroupOf(symbol: string): "GOLD" | "FOREX" | "OTHER" {
  const mk = resolveArxMarket(symbol);
  if (!mk) return "OTHER";
  if (mk.canonicalSymbol === "XAUUSD") return "GOLD";
  return mk.category === "forex_major" || mk.category === "forex_minor" ? "FOREX" : "OTHER";
}

/** Strategy with the best average R on tracked outcomes in one market group; null if none was tracked there. */
function bestInMarket(tracked: ShadowDecision[], group: "GOLD" | "FOREX"): string | null {
  const by = new Map<string, { n: number; sumR: number }>();
  for (const d of tracked) {
    if (marketGroupOf(d.symbol) !== group) continue;
    const s = by.get(d.strategy) ?? { n: 0, sumR: 0 };
    s.n++; s.sumR += d.pnlR ?? 0; by.set(d.strategy, s);
  }
  let best: { k: string; avgR: number; n: number } | null = null;
  for (const [k, v] of by) {
    const avgR = v.sumR / v.n;
    if (!best || avgR > best.avgR || (avgR === best.avgR && v.n > best.n)) best = { k, avgR, n: v.n };
  }
  return best?.k ?? null;
}

export function tournamentResults() {
  const since = tournamentStartedAt ? Date.parse(tournamentStartedAt) : 0;
  const arr = [...decisions.values()].filter((d) => Date.parse(d.ts) >= since && !isScanPlaceholder(d.strategy));
  const byStrategy: Record<string, { decisions: number; ideas: number; n: number; wins: number; losses: number; sumR: number; grossWinR: number; grossLossR: number; rgBlocks: number; gradeSum: number; gradeN: number }> = {};
  for (const d of arr) {
    const s = byStrategy[d.strategy] = byStrategy[d.strategy] ?? { decisions: 0, ideas: 0, n: 0, wins: 0, losses: 0, sumR: 0, grossWinR: 0, grossLossR: 0, rgBlocks: 0, gradeSum: 0, gradeN: 0 };
    s.decisions++;
    if (d.action !== "WAIT") s.ideas++;
    s.gradeSum += d.grade; s.gradeN++;
    if (rgBlocked(d)) s.rgBlocks++;
    if (d.status === "SHADOW_WIN" || d.status === "SHADOW_LOSS") {
      const r = d.pnlR ?? 0;
      s.n++; s.sumR += r;
      if (d.status === "SHADOW_WIN") s.wins++; else s.losses++;
      if (r > 0) s.grossWinR += r; else s.grossLossR += -r;
    }
  }
  // Only strategies with at least one tracked win or loss have a win rate or
  // expectancy, so only they are ranked; the rest are listed as unranked.
  const unranked = Object.entries(byStrategy).filter(([, s]) => s.n === 0)
    .map(([strategy, s]) => ({ strategy, decisions: s.decisions, reason: "No tracked win or loss yet" }));
  const rows = Object.entries(byStrategy).filter(([, s]) => s.n > 0).map(([strategy, s]) => {
    const winRate = s.n ? s.wins / s.n : 0;
    const avgR = s.n ? s.sumR / s.n : 0;
    // Profit factor = R won / R lost. With nothing lost it cannot be computed
    // (null), never the win count.
    const profitFactor = s.grossLossR > 0 ? s.grossWinR / s.grossLossR : null;
    // Expectancy per tracked trade, in R, is the average R itself.
    const expectancy = avgR;
    const riskAdj = s.n ? avgR / Math.max(0.5, Math.sqrt(s.n)) : 0;
    return {
      strategy, sample: s.n, winRate: Number((winRate * 100).toFixed(1)),
      avgR: Number(avgR.toFixed(2)),
      profitFactor: profitFactor === null ? null : Number(profitFactor.toFixed(2)),
      expectancy: Number(expectancy.toFixed(2)),
      riskAdjustedReturn: Number(riskAdj.toFixed(2)),
      qualitySetups: s.n,
      confidenceAccuracy: confidenceAccuracyFor(strategy, arr),
      // Share of this strategy's proposed trades (BUY/SELL) the risk governor allowed.
      riskDiscipline: s.ideas ? Math.round(((s.ideas - s.rgBlocks) / s.ideas) * 100) : null,
      tradeGradeAvg: Number((s.gradeSum / Math.max(1, s.gradeN)).toFixed(2)),
    };
  }).sort((a, b) => b.expectancy - a.expectancy);
  const tracked = arr.filter((d) => d.status === "SHADOW_WIN" || d.status === "SHADOW_LOSS");
  const leaderboard = {
    bestOverall: rows[0]?.strategy ?? null,
    bestLowRisk: [...rows].sort((a, b) => (b.riskDiscipline ?? -1) - (a.riskDiscipline ?? -1))[0]?.strategy ?? null,
    // No shadow decision records a scalping style (every one is an M15 scan),
    // so no strategy can be named best at scalping.
    bestScalping: null as string | null,
    // Best on the market actually traded, not a guess from the strategy's name.
    bestGold: bestInMarket(tracked, "GOLD"),
    bestForex: bestInMarket(tracked, "FOREX"),
    // One ranked strategy is not both the best and the worst.
    worst: rows.length >= 2 ? rows.at(-1)!.strategy : null,
    toRetire: rows.find((r) => r.expectancy < 0 && r.sample >= 10)?.strategy ?? null,
  };
  // A tournament only observes while shadow mode produces decisions.
  const running = tournamentEnabled && shadowEnabled;
  const idleReason = running ? null : !tournamentEnabled ? "NOT_STARTED" as const : "SHADOW_STOPPED" as const;
  return { running, idleReason, startedAt: tournamentStartedAt, ranked: rows, unranked, leaderboard, dataSource: "SHADOW" as const };
}

// ── Confidence Calibration ────────────────────────────────────────────────
/** Tracked outcomes needed before a calibration label is computed. */
export const CALIBRATION_MIN_TOTAL = 20;
/** Tracked outcomes needed on EACH side (confidence 80-100 and 50-70). */
export const CALIBRATION_MIN_PER_SIDE = 10;
export function confidenceCalibration() {
  const arr = [...decisions.values()].filter((d) => d.status === "SHADOW_WIN" || d.status === "SHADOW_LOSS");
  const buckets = [
    { label: "50-60", min: 50, max: 60 }, { label: "60-70", min: 60, max: 70 },
    { label: "70-80", min: 70, max: 80 }, { label: "80-90", min: 80, max: 90 },
    { label: "90-100", min: 90, max: 101 },
  ];
  const counted = buckets.map((b) => {
    const xs = arr.filter((d) => d.confidence >= b.min && d.confidence < b.max);
    return { b, n: xs.length, wins: xs.filter((d) => d.status === "SHADOW_WIN").length, sumR: xs.reduce((a, d) => a + (d.pnlR ?? 0), 0) };
  });
  // An empty bucket has no win rate or average R (null) — never 0%.
  const out = counted.map(({ b, n, wins, sumR }) => ({
    bucket: b.label, sample: n,
    winRate: n ? Number(((wins / n) * 100).toFixed(1)) : null,
    avgR: n ? Number((sumR / n).toFixed(2)) : null,
  }));
  // Calibration compares observed high-confidence (80-100) with low-confidence
  // (50-70) outcomes, pooled per side. Without enough of BOTH it cannot be
  // judged, so it stays NEEDS_MORE_DATA.
  const side = (labels: string[]) => counted.filter((c) => labels.includes(c.b.label))
    .reduce((a, c) => ({ n: a.n + c.n, wins: a.wins + c.wins }), { n: 0, wins: 0 });
  const high = side(["80-90", "90-100"]);
  const low = side(["50-60", "60-70"]);
  let label: "WELL_CALIBRATED" | "OVERCONFIDENT" | "UNDERCONFIDENT" | "RANDOM_CONFIDENCE" | "NEEDS_MORE_DATA" = "NEEDS_MORE_DATA";
  if (arr.length >= CALIBRATION_MIN_TOTAL && high.n >= CALIBRATION_MIN_PER_SIDE && low.n >= CALIBRATION_MIN_PER_SIDE) {
    const highWR = (high.wins / high.n) * 100;
    const lowWR = (low.wins / low.n) * 100;
    const slope = highWR - lowWR;
    if (Math.abs(slope) < 5) label = "RANDOM_CONFIDENCE";
    else if (slope > 15) label = "WELL_CALIBRATED";
    else if (highWR < 60) label = "OVERCONFIDENT";
    else label = "UNDERCONFIDENT";
  }
  const labelBasis = label !== "NEEDS_MORE_DATA"
    ? `Compared ${high.n} high-confidence (80-100) with ${low.n} low-confidence (50-70) tracked outcomes.`
    : `Needs at least ${CALIBRATION_MIN_TOTAL} tracked outcomes with ${CALIBRATION_MIN_PER_SIDE}+ at confidence 80-100 and ${CALIBRATION_MIN_PER_SIDE}+ at 50-70; observed ${arr.length} in total, ${high.n} high and ${low.n} low.`;
  return {
    buckets: out, totalSample: arr.length, label, labelBasis,
    highConfidenceSample: high.n, lowConfidenceSample: low.n,
    dataSource: "SHADOW" as const,
  };
}
function avg(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
/** 100 minus the gap between average confidence and observed win rate; null when nothing was tracked. */
function confidenceAccuracyFor(strategy: string, pool: ShadowDecision[]): number | null {
  const arr = pool.filter((d) => d.strategy === strategy && (d.status === "SHADOW_WIN" || d.status === "SHADOW_LOSS"));
  if (!arr.length) return null;
  const expectedWR = avg(arr.map((d) => d.confidence));
  const actualWR = (arr.filter((d) => d.status === "SHADOW_WIN").length / arr.length) * 100;
  return Math.max(0, Math.round(100 - Math.abs(expectedWR - actualWR)));
}

// ── Promotion / Demotion Gates ────────────────────────────────────────────
export type PromotionLevel = "TESTING" | "WATCHLIST" | "PAPER_APPROVED" | "DEMO_APPROVED" | "LIVE_INTENT_APPROVED" | "FUTURE_MT5_LIVE_LOCKED";
export type DemotionLevel = "WATCHLIST" | "NEEDS_REVIEW" | "PAUSED" | "RETIRED";

interface StrategyGate { strategy: string; level: PromotionLevel; demotion: DemotionLevel | null; updatedAt: string; lastReason: string }
/** A gate as read: updatedAt/lastReason are null until a promotion or demotion happens. */
type StrategyGateView = Omit<StrategyGate, "updatedAt" | "lastReason"> & { updatedAt: string | null; lastReason: string | null };
// Gate records exist only once an admin promoted or demoted the strategy.
const gates = new Map<string, StrategyGate>();
function getGate(strategy: string): StrategyGate {
  let g = gates.get(strategy);
  if (!g) { g = { strategy, level: "TESTING", demotion: null, updatedAt: new Date().toISOString(), lastReason: "init" }; gates.set(strategy, g); }
  return g;
}
/** Read-only gate: never creates a record, so reading the page is not an event. */
function viewGate(strategy: string): StrategyGateView {
  return gates.get(strategy) ?? { strategy, level: "TESTING", demotion: null, updatedAt: null, lastReason: null };
}
/**
 * Strategies the gates cover: every strategy that made a shadow decision
 * (scan placeholders excluded) plus any an admin already promoted or demoted.
 */
function gatedStrategies(): string[] {
  const names = new Set<string>();
  for (const d of decisions.values()) if (!isScanPlaceholder(d.strategy)) names.add(d.strategy);
  for (const k of gates.keys()) names.add(k);
  return Array.from(names);
}

function strategyStats(strategy: string) {
  const arr = [...decisions.values()].filter((d) => d.strategy === strategy);
  const tracked = arr.filter((d) => d.status === "SHADOW_WIN" || d.status === "SHADOW_LOSS");
  const wins = tracked.filter((d) => d.status === "SHADOW_WIN");
  const winRate = tracked.length ? wins.length / tracked.length : 0;
  const avgR = tracked.length ? tracked.reduce((a, d) => a + (d.pnlR ?? 0), 0) / tracked.length : 0;
  const dd = maxDrawdownR(arr);
  const rgViolations = arr.filter(rgBlocked).length;
  // Expectancy per tracked trade, in R, is the average R itself.
  const expectancy = avgR;
  return { sample: arr.length, tracked: tracked.length, winRate, avgR, drawdownR: dd, rgViolations, expectancy };
}

export function promotionStatus() {
  return gatedStrategies().map((s) => {
    const g = viewGate(s); const st = strategyStats(s); const cal = confidenceCalibration();
    const eligible = computeNextLevel(g.level, st, cal.label);
    return { ...g, stats: st, eligibleFor: eligible };
  });
}
function computeNextLevel(curr: PromotionLevel, st: ReturnType<typeof strategyStats>, calLabel: string): PromotionLevel | null {
  if (curr === "FUTURE_MT5_LIVE_LOCKED") return null;
  if (curr === "LIVE_INTENT_APPROVED") return null;
  // PAPER_APPROVED gate
  if (curr === "TESTING" || curr === "WATCHLIST") {
    if (st.tracked >= 20 && st.winRate >= 0.5 && st.avgR > 0 && st.drawdownR <= 5 && st.rgViolations === 0) return "PAPER_APPROVED";
    return null;
  }
  if (curr === "PAPER_APPROVED") {
    if (st.tracked >= 50 && st.expectancy > 0 && st.drawdownR <= 8 && (calLabel === "WELL_CALIBRATED" || calLabel === "UNDERCONFIDENT")) return "DEMO_APPROVED";
    return null;
  }
  if (curr === "DEMO_APPROVED") {
    if (st.tracked >= 100 && st.expectancy > 0 && (calLabel === "WELL_CALIBRATED") && st.rgViolations === 0) return "LIVE_INTENT_APPROVED";
    return null;
  }
  return null;
}
export function promote(strategy: string, by: string): { ok: boolean; gate?: StrategyGate; error?: string } {
  const st = strategyStats(strategy); const cal = confidenceCalibration();
  const next = computeNextLevel(viewGate(strategy).level, st, cal.label);
  if (!next) return { ok: false, error: `Strategy ${strategy} not eligible from ${viewGate(strategy).level}` };
  const g = getGate(strategy);
  g.level = next; g.demotion = null; g.updatedAt = new Date().toISOString();
  g.lastReason = `Promoted to ${next} by ${by}; sample=${st.tracked}, wr=${(st.winRate * 100).toFixed(1)}%, exp=${st.expectancy.toFixed(2)}`;
  return { ok: true, gate: g };
}
export function demote(strategy: string, level: DemotionLevel, reason: string, by: string): StrategyGate {
  const g = getGate(strategy);
  g.demotion = level; g.updatedAt = new Date().toISOString(); g.lastReason = `Demoted to ${level} by ${by}: ${reason}`;
  if (level === "RETIRED") g.level = "TESTING";
  return g;
}
export function demotionScan() {
  // Checks the same strategies the gates list (the ones that make decisions).
  // WIN_RATE_LOW / NEGATIVE_R need 10+ tracked outcomes; `tracked` says how many there were.
  const out: Array<{ strategy: string; suggested: DemotionLevel | null; reasons: string[]; tracked: number }> = [];
  for (const s of gatedStrategies()) {
    const st = strategyStats(s);
    const reasons: string[] = [];
    if (st.tracked >= 10 && st.winRate < 0.3) reasons.push("WIN_RATE_LOW");
    if (st.tracked >= 10 && st.avgR < 0) reasons.push("NEGATIVE_R");
    if (st.drawdownR > 10) reasons.push("DRAWDOWN_HIGH");
    if (st.rgViolations >= 5) reasons.push("REPEATED_RISK_BLOCKS");
    let suggested: DemotionLevel | null = null;
    if (reasons.length >= 3) suggested = "RETIRED";
    else if (reasons.length === 2) suggested = "PAUSED";
    else if (reasons.length === 1) suggested = "NEEDS_REVIEW";
    out.push({ strategy: s, suggested, reasons, tracked: st.tracked });
  }
  return out;
}

// ── AI Readiness Score ────────────────────────────────────────────────────
/** Tracked outcomes (wins + losses) needed before readiness can read PAPER_READY or above. */
export const READINESS_MIN_TRACKED_OUTCOMES = 20;

/**
 * Composite of MEASURED factors only. A factor nothing measures (a constant,
 * or a stand-in derived from confidence) earns no points: it is listed under
 * notMeasured with why, never given a score. With fewer than
 * READINESS_MIN_TRACKED_OUTCOMES tracked outcomes the label is capped at
 * NEEDS_MORE_TESTING, whatever the average.
 */
export function readinessScore() {
  const all = [...decisions.values()];
  const tracked = all.filter((d) => d.status === "SHADOW_WIN" || d.status === "SHADOW_LOSS");
  const wins = tracked.filter((d) => d.status === "SHADOW_WIN").length;
  const resolvedWithR = all.filter((d) => d.pnlR != null);
  const ideas = all.filter((d) => d.action !== "WAIT");
  const cal = confidenceCalibration();

  const factors: Record<string, number> = {};
  const notMeasured: Array<{ factor: string; why: string }> = [];
  const factor = (name: string, value: number | null, why: string) => {
    if (value === null) notMeasured.push({ factor: name, why });
    else factors[name] = value;
  };

  factor("strategyPerformance", tracked.length ? Math.round((wins / tracked.length) * 100) : null,
    "No tracked win or loss yet.");
  factor("confidenceCalibration",
    cal.label === "NEEDS_MORE_DATA" ? null
      : cal.label === "WELL_CALIBRATED" ? 100 : cal.label === "UNDERCONFIDENT" ? 75 : cal.label === "OVERCONFIDENT" ? 40 : 20,
    `Calibration needs more data: ${cal.labelBasis}`);
  factor("riskDiscipline",
    ideas.length ? Math.max(0, 100 - Math.round((ideas.filter(rgBlocked).length / ideas.length) * 100)) : null,
    "No trade was proposed, so the risk governor checked nothing.");
  factor("drawdownBehavior", resolvedWithR.length ? Math.max(0, 100 - Math.round(maxDrawdownR(all) * 8)) : null,
    "No outcome with a measured R yet.");
  factor("sampleSize", Math.min(100, tracked.length), "");
  factor("overtradingBehavior", null, "Nothing measures over-trading in shadow mode.");
  factor("tradeGradeAvg", null, "Each decision's trade grade is its confidence / 10, not an independent grade.");
  factor("entrySniperAvg", null, "Each decision's entry score is its confidence - 5, not a measured entry quality.");
  factor("opportunityScoreAccuracy", null, "Each decision's opportunity score is its confidence; no accuracy is computed.");
  factor("learningLoopStability", null, "Nothing measures learning-loop stability in shadow mode.");
  factor("safetyCompliance", null, "No safety-compliance check feeds this score.");

  const measured = Object.values(factors);
  const score = Math.round(avg(measured));
  let label: "NOT_READY" | "NEEDS_MORE_TESTING" | "PAPER_READY" | "DEMO_READY" | "LIVE_INTENT_READY" = score < 50 ? "NOT_READY" : score < 70 ? "NEEDS_MORE_TESTING" : score < 85 ? "PAPER_READY" : score < 95 ? "DEMO_READY" : "LIVE_INTENT_READY";
  if (tracked.length < READINESS_MIN_TRACKED_OUTCOMES && label !== "NOT_READY") label = "NEEDS_MORE_TESTING";
  return {
    score, label, factors, notMeasured,
    trackedOutcomes: tracked.length,
    minTrackedOutcomes: READINESS_MIN_TRACKED_OUTCOMES,
    basis: `Average of ${measured.length} measured factor${measured.length === 1 ? "" : "s"} over ${tracked.length} tracked outcome${tracked.length === 1 ? "" : "s"}; ${notMeasured.length} not measured and not scored.`
      + (tracked.length < READINESS_MIN_TRACKED_OUTCOMES ? ` Below ${READINESS_MIN_TRACKED_OUTCOMES} tracked outcomes the label cannot be higher than NEEDS_MORE_TESTING.` : ""),
    realBrokerReadiness: "Real broker readiness unavailable until MT5 bridge is connected.",
    dataSource: "SHADOW" as const,
  };
}

// ── Shadow Journal ────────────────────────────────────────────────────────
/**
 * Journal verdict: RIGHT / WRONG only for a measured win / loss; BREAKEVEN for
 * an idea that expired within 0.1R of entry; PENDING only while the tracker
 * is still watching it; NOT_TRADED when no trade was proposed or the risk
 * governor blocked it; NOT_MEASURED when the idea ended with no R measured.
 */
export type JournalVerdict = "RIGHT" | "WRONG" | "PENDING" | "BREAKEVEN" | "NOT_TRADED" | "NOT_MEASURED";

export function shadowJournal(limit = 200) {
  const arr = [...decisions.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, limit);
  return arr.map((d) => ({
    id: d.id, ts: d.ts, symbol: d.symbol, strategy: d.strategy, marketCondition: d.marketCondition,
    aiSaw: d.reason, whatHappened: whatHappened(d),
    rightOrWrong: verdictFor(d),
    lesson: lessonFor(d), dataSource: "SHADOW" as const,
  }));
}
function fmtR(r: number): string { return `${r > 0 ? "+" : ""}${r.toFixed(2)}`; }
function whatHappened(d: ShadowDecision): string {
  switch (d.status) {
    case "SHADOW_WIN":
    case "SHADOW_LOSS":
      return d.pnlR != null ? `${d.status} (R=${fmtR(d.pnlR)})` : `${d.status} (R not recorded)`;
    case "SHADOW_BREAKEVEN":
      return `${d.status} (R=0.00: within 0.1R of entry when the window ended)`;
    case "SHADOW_EXPIRED":
      if (d.untrackedReason === "TRACKING_STOPPED") return `${d.status} — R not measured: shadow mode was stopped before the idea reached its stop or target`;
      if (d.sl == null || d.tp == null || d.sl === d.entry) return `${d.status} — R not measured: the idea had no usable stop and target`;
      return `${d.status} — R not measured: neither stop nor target was reached before the window ended`;
    case "SHADOW_TRADE_IDEA":
      return d.untrackedReason === "TRACKER_NOT_RUNNING"
        ? `${d.status} — outcome not tracked: shadow mode was stopped when it was made`
        : `${d.status} — outcome not tracked`;
    case "SHADOW_REJECTED": return `${d.status} — blocked by the risk governor, not traded`;
    case "SHADOW_WAIT": return `${d.status} — no trade proposed`;
    case "SHADOW_TRACKING_OUTCOME": return `${d.status} — open, tracked until ${d.expiresAt}`;
    default: return d.status;
  }
}
function verdictFor(d: ShadowDecision): JournalVerdict {
  switch (d.status) {
    case "SHADOW_WIN": return "RIGHT";
    case "SHADOW_LOSS": return "WRONG";
    case "SHADOW_BREAKEVEN": return "BREAKEVEN";
    case "SHADOW_TRACKING_OUTCOME": return "PENDING";
    case "SHADOW_REJECTED":
    case "SHADOW_WAIT": return "NOT_TRADED";
    default: return "NOT_MEASURED";
  }
}
function lessonFor(d: ShadowDecision): string {
  if (d.status === "SHADOW_LOSS" && d.confidence >= 80) return "High-confidence loss — recalibrate model";
  if (d.status === "SHADOW_WIN" && d.confidence < 60) return "Low-confidence win — model may be too cautious";
  if (d.status === "SHADOW_REJECTED") return `Risk Governor rejection: ${d.reasonToAvoid}`;
  if (d.untrackedReason) return "No lesson: the outcome was not observed.";
  if (d.status === "SHADOW_EXPIRED") return "Expired without reaching its stop or target; the cause was not analysed.";
  return "Neutral observation";
}

// Dashboard cards
export function dashboardCards() {
  const s = shadowStatus();
  const r = readinessScore();
  const t = tournamentResults();
  const cal = confidenceCalibration();
  const tracked = s.wins + s.losses;
  const winRate = tracked ? (s.wins / tracked) * 100 : 0;
  const arr = [...decisions.values()].filter((d) => d.pnlR != null);
  const avgR = arr.length ? arr.reduce((a, d) => a + (d.pnlR ?? 0), 0) / arr.length : 0;
  return {
    shadowStatus: s.enabled ? "RUNNING" : "STOPPED",
    forwardTest: forwardConfig ? { running: true, endsAt: forwardEndsAt } : { running: false },
    topStrategy: t.leaderboard.bestOverall,
    worstStrategy: t.leaderboard.worst,
    aiReadinessScore: r.score, aiReadinessLabel: r.label,
    confidenceCalibration: cal.label,
    strategyPromotionStatus: promotionStatus().map((p) => ({ strategy: p.strategy, level: p.level, eligibleFor: p.eligibleFor })),
    shadowWinRate: Number(winRate.toFixed(1)),
    shadowAvgR: Number(avgR.toFixed(2)),
    tournamentWinner: t.leaderboard.bestOverall,
    dataSource: "SHADOW" as const,
  };
}
