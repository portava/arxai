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
// - Risk Governor 2.0 is invoked for every shadow decision (advisory) — it
//   cannot be bypassed because we call preTradeCheck() with the same payload
//   the OMS would.

import { marketSimulator } from "./marketSimulator.js";
import { preTradeCheck } from "./riskGovernor2.js";
import { runStrategyScan, type Candle as EngineCandle } from "./strategyEngine.js";
import { ENGINE_STRATEGY_NAMES } from "./backtestStrategyRegistry.js";
import { resolveArxMarket } from "@workspace/domain/market";
import { DEFAULT_SYMBOLS } from "./marketScanner.js";
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

// ── Data-source coverage (audit rank 67) ────────────────────────────────────
//
// The shadow scanner's ONLY candle source is marketSimulator, which knows eight
// symbols. The scan set defaults to the ~23 tier-1 ARX markets, so every symbol
// outside the simulator used to return null on every tick — silently, with no
// log and no counter. The card then read as coverage of the platform's market
// list while three symbols were ever actually observed.
/** Symbols the shadow scanner's data source can actually produce candles for. */
export function shadowCoveredSymbols(): string[] {
  return marketSimulator.symbols().map((s) => s.symbol);
}
function partitionBySourceCoverage(symbols: readonly string[]): { covered: string[]; skipped: string[] } {
  const known = new Set(shadowCoveredSymbols().map((s) => s.toUpperCase()));
  const covered: string[] = [];
  const skipped: string[] = [];
  for (const s of symbols) (known.has(s.toUpperCase()) ? covered : skipped).push(s);
  return { covered, skipped };
}

export type ShadowStatus =
  | "SHADOW_OBSERVATION" | "SHADOW_TRADE_IDEA" | "SHADOW_WAIT" | "SHADOW_REJECTED"
  | "SHADOW_TRACKING_OUTCOME" | "SHADOW_WIN" | "SHADOW_LOSS" | "SHADOW_BREAKEVEN" | "SHADOW_EXPIRED";

export interface ShadowDecision {
  id: string; ts: string; symbol: string; tf: string; strategy: string;
  marketCondition: string; action: "BUY" | "SELL" | "WAIT"; entry: number; sl: number; tp: number;
  confidence: number; opportunity: number; sniper: number; grade: number;
  riskGovernor: { approved: boolean; level: string; hardBlocks: string[]; warnings: string[] };
  reason: string; reasonToAvoid: string;
  status: ShadowStatus; expiresAt: string; pnlR?: number; outcomeAt?: string;
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
  const sl = scan.stopLoss || (scan.direction === "BUY" ? entry * 0.997 : entry * 1.003);
  const tp = scan.takeProfit || (scan.direction === "BUY" ? entry * 1.005 : entry * 0.995);
  const action = scan.direction === "WAIT" ? "WAIT" : (scan.direction as "BUY" | "SELL");

  const rg = preTradeCheck({
    environment: "DEMO_SIMULATOR", source: "AI_AUTO",
    symbol, direction: action === "WAIT" ? "BUY" : action,
    lotSize: 0.01, entryPrice: entry, stopLoss: sl, takeProfit: tp,
    riskAmount: 5, confidenceScore: scan.confidence,
    entrySniperScore: scan.confidence, opportunityScore: scan.confidence,
  });

  let status: ShadowStatus =
    action === "WAIT" ? "SHADOW_WAIT"
      : !rg.approved ? "SHADOW_REJECTED"
      : "SHADOW_TRACKING_OUTCOME";

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
    dataSource: "SHADOW",
    featureSetId: FEATURE_SET_ID,
    featureSnapshot,
  };
  decisions.set(d.id, d);
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

// The symbols this run of the scanner is actually observing, and the ones that
// were requested but have no candle source. Both are reported by shadowStatus()
// so no surface can read the requested list as coverage.
let scanSymbols: string[] = [];
let skippedSymbols: string[] = [];

export function startShadowMode(opts?: { symbols?: string[]; intervalSec?: number }): {
  running: boolean; startedAt: string | null;
  scannedSymbols: string[]; skippedSymbols: string[];
} {
  if (shadowEnabled) {
    return { running: true, startedAt: shadowStartedAt, scannedSymbols: [...scanSymbols], skippedSymbols: [...skippedSymbols] };
  }
  const requested = opts?.symbols && opts.symbols.length ? [...opts.symbols] : [...DEFAULT_SYMBOLS];
  // Restrict the scan set to symbols the data source covers, and REPORT the
  // rest instead of failing null on every tick for them (audit rank 67).
  const { covered, skipped } = partitionBySourceCoverage(requested);
  scanSymbols = covered;
  skippedSymbols = skipped;
  shadowEnabled = true; shadowStartedAt = new Date().toISOString();
  const intervalMs = Math.max(2, opts?.intervalSec ?? 5) * 1000;
  scanTimer = setInterval(() => {
    if (!shadowEnabled) return;
    for (const s of scanSymbols) createShadowDecision(s, "M15");
  }, intervalMs);
  scanTimer.unref?.();
  trackTimer = setInterval(trackOutcomes, 1000);
  trackTimer.unref?.();
  return { running: true, startedAt: shadowStartedAt, scannedSymbols: [...scanSymbols], skippedSymbols: [...skippedSymbols] };
}
export function stopShadowMode() {
  shadowEnabled = false;
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
  return { running: false };
}
export function shadowStatus() {
  const arr = [...decisions.values()];
  return {
    enabled: shadowEnabled, startedAt: shadowStartedAt,
    // Coverage truth (audit rank 67): what is actually observed, what was asked
    // for and cannot be, and where the candles come from.
    scannedSymbols: [...scanSymbols],
    skippedSymbols: [...skippedSymbols],
    skippedSymbolCount: skippedSymbols.length,
    candleSource: "SYNTHETIC_SIMULATOR" as const,
    coverageNote: skippedSymbols.length
      ? `Observing ${scanSymbols.length} of ${scanSymbols.length + skippedSymbols.length} requested symbols. ` +
        `${skippedSymbols.length} have no candle source in the simulator and are NOT shadow-tested: ` +
        `${skippedSymbols.join(", ")}.`
      : `Observing ${scanSymbols.length} symbol(s) on synthetic simulator candles.`,
    totalsObserved, totalDecisions: arr.length,
    tracking: arr.filter((d) => d.status === "SHADOW_TRACKING_OUTCOME").length,
    wins: arr.filter((d) => d.status === "SHADOW_WIN").length,
    losses: arr.filter((d) => d.status === "SHADOW_LOSS").length,
    breakevens: arr.filter((d) => d.status === "SHADOW_BREAKEVEN").length,
    expired: arr.filter((d) => d.status === "SHADOW_EXPIRED").length,
    rejected: arr.filter((d) => d.status === "SHADOW_REJECTED").length,
    waits: arr.filter((d) => d.status === "SHADOW_WAIT").length,
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
let forwardStartedAt: string | null = null;
let forwardEndsAt: string | null = null;
let forwardCountAtStart = 0;
// Audit rank 69: stopForwardTest() used to only null the config. The scanner
// kept running and forwardResults() kept absorbing new decisions, so a
// "finished" forward test's tiles carried on climbing after Stop. The window is
// now explicitly bounded, the config is retained for the frozen read, and the
// scanner is stopped again if this forward test is what started it.
let forwardRunning = false;
let forwardEndedAt: string | null = null;
let forwardStartedScanner = false;

export function startForwardTest(c: Partial<ForwardTestConfig> = {}): { running: boolean; endsAt: string } {
  forwardConfig = {
    strategy: c.strategy, symbols: c.symbols ?? [...DEFAULT_SYMBOLS], timeframes: c.timeframes ?? ["M15"],
    durationMin: c.durationMin ?? 60, maxShadowTrades: c.maxShadowTrades ?? 100, maxTradesPerDay: c.maxTradesPerDay ?? 30,
    minConfidence: c.minConfidence ?? 60, minOpportunity: c.minOpportunity ?? 60, minTradeGrade: c.minTradeGrade ?? 6,
    riskProfile: c.riskProfile ?? "CONSERVATIVE",
    sessionFilters: c.sessionFilters ?? [], newsFilters: c.newsFilters ?? [],
  };
  forwardStartedAt = new Date().toISOString();
  forwardEndedAt = null;
  forwardRunning = true;
  forwardEndsAt = new Date(Date.now() + forwardConfig.durationMin * 60_000).toISOString();
  forwardCountAtStart = totalsObserved;
  forwardStartedScanner = false;
  if (!shadowEnabled) {
    startShadowMode({ symbols: forwardConfig.symbols });
    forwardStartedScanner = true;
  }
  return { running: true, endsAt: forwardEndsAt };
}
export function stopForwardTest() {
  const c = forwardConfig;
  const wasRunning = forwardRunning;
  forwardRunning = false;
  // Freeze the window at the moment of Stop. forwardConfig is retained (not
  // nulled) so the frozen read keeps the strategy filter it was scoped by.
  if (wasRunning) forwardEndedAt = new Date().toISOString();
  // If this forward test started the scanner, stop it again — otherwise the
  // shadow stream keeps running unattended after the user pressed Stop.
  let scannerStopped = false;
  if (forwardStartedScanner && shadowEnabled) {
    stopShadowMode();
    scannerStopped = true;
  }
  forwardStartedScanner = false;
  return { stopped: true, was: c, endedAt: forwardEndedAt, scannerStopped };
}

/** Inclusive [start, end] bounds of the forward window; end is null while running. */
function forwardWindow(): { since: number; until: number } {
  return {
    since: forwardStartedAt ? Date.parse(forwardStartedAt) : 0,
    until: forwardEndedAt ? Date.parse(forwardEndedAt) : Number.POSITIVE_INFINITY,
  };
}
function forwardDecisions(): ShadowDecision[] {
  const { since, until } = forwardWindow();
  return [...decisions.values()].filter((d) => {
    const t = Date.parse(d.ts);
    return t >= since && t <= until &&
      (!forwardConfig?.strategy || d.strategy === forwardConfig.strategy);
  });
}

export function forwardStatus() {
  return {
    running: forwardRunning, startedAt: forwardStartedAt, endsAt: forwardEndsAt,
    endedAt: forwardEndedAt,
    config: forwardConfig, observedSinceStart: totalsObserved - forwardCountAtStart,
    // The window the results below are bounded by. After Stop this is frozen,
    // so two people reading the page see the same numbers.
    windowFrozen: !forwardRunning && forwardEndedAt !== null,
    dataSource: "SHADOW" as const,
  };
}
export function forwardResults() {
  const arr = forwardDecisions();
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
  const ranked = (m: Record<string, { n: number; wins: number }>) =>
    Object.entries(m).map(([k, v]) => ({ k, winRate: v.n ? v.wins / v.n : 0, n: v.n })).sort((a, b) => b.winRate - a.winRate);
  const symbolRank = ranked(bySymbol);
  const stratRank = ranked(byStrategy);
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
    bestSymbol: symbolRank[0]?.k ?? null, worstSymbol: symbolRank.at(-1)?.k ?? null,
    bestStrategy: stratRank[0]?.k ?? null, weakestStrategy: stratRank.at(-1)?.k ?? null,
    confidenceCalibration: confidenceCalibration().label,
    dataSource: "SHADOW" as const,
  };
}
// Forward-test equity (R-multiple) chart series (Task #763) — DISPLAY-ONLY.
// Same scope as forwardResults(): decisions since the forward test started,
// filtered to the active strategy. Pure derivation via buildForwardChartSeries.
export function forwardChartSeries(): ForwardChartSeries {
  const arr = forwardDecisions();
  return buildForwardChartSeries(arr.map((d) => ({
    id: d.id, ts: d.ts, symbol: d.symbol, strategy: d.strategy,
    action: d.action, entry: d.entry, status: d.status,
    pnlR: d.pnlR, outcomeAt: d.outcomeAt,
  })));
}

// Category slots are derived from the decision's SYMBOL — a fact the decision
// carries — through the ARX market registry, never from the strategy's NAME.
// A symbol the registry does not know is excluded rather than guessed into a
// category. `bestOnGold` means gold: XAG (silver) is a metal but not gold, so
// it is no longer folded into the slot the card names.
export function isGoldSymbol(symbol: string): boolean {
  const m = resolveArxMarket(symbol);
  if (m) return m.category === "metal" && /^XAU/i.test(m.canonicalSymbol);
  return /^XAU/i.test(symbol);
}
export function isForexSymbol(symbol: string): boolean {
  const m = resolveArxMarket(symbol);
  if (!m) return false;
  return m.category === "forex_major" || m.category === "forex_minor";
}

/** Strategies present in `arr`, ordered by win rate over resolved decisions. */
function rankByStrategyOverDecisions(arr: ShadowDecision[]): string[] {
  const by: Record<string, { n: number; wins: number }> = {};
  for (const d of arr) {
    if (d.status !== "SHADOW_WIN" && d.status !== "SHADOW_LOSS") continue;
    by[d.strategy] = by[d.strategy] ?? { n: 0, wins: 0 };
    by[d.strategy]!.n++;
    if (d.status === "SHADOW_WIN") by[d.strategy]!.wins++;
  }
  return Object.entries(by)
    .sort((a, b) => (b[1].wins / b[1].n) - (a[1].wins / a[1].n))
    .map(([k]) => k);
}

function maxDrawdownR(arr: ShadowDecision[]): number {
  let peak = 0, cum = 0, dd = 0;
  for (const d of arr.filter((x) => x.pnlR != null).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    cum += d.pnlR ?? 0; if (cum > peak) peak = cum; dd = Math.min(dd, cum - peak);
  }
  return Math.abs(dd);
}

// ── Strategy Tournament ───────────────────────────────────────────────────
//
// Audit rank 70: this was a hand-written list of six names, but the only
// producer of shadow decisions is runStrategyScan, whose strategy values are a
// different eight — only 2 of the 6 could ever match. The Promotion tab
// therefore listed four strategies permanently at n=0 / tracked=0 / wr=0% with
// a Promote button that could never enable, however long shadow mode ran.
// The universe is now DERIVED from the engine's own registry, so it cannot
// drift from the set of strategies that can produce a decision.
export const TOURNAMENT_STRATEGIES: string[] = [...ENGINE_STRATEGY_NAMES];
let tournamentStartedAt: string | null = null;
let tournamentEnabled = false;

export function startTournament(): { running: boolean } {
  tournamentEnabled = true; tournamentStartedAt = new Date().toISOString();
  if (!shadowEnabled) startShadowMode();
  return { running: true };
}
export function tournamentResults() {
  const since = tournamentStartedAt ? Date.parse(tournamentStartedAt) : 0;
  const arr = [...decisions.values()].filter((d) => Date.parse(d.ts) >= since);
  const byStrategy: Record<string, { n: number; wins: number; losses: number; sumR: number; rgBlocks: number; gradeSum: number; gradeN: number }> = {};
  for (const d of arr) {
    const s = byStrategy[d.strategy] = byStrategy[d.strategy] ?? { n: 0, wins: 0, losses: 0, sumR: 0, rgBlocks: 0, gradeSum: 0, gradeN: 0 };
    s.gradeSum += d.grade; s.gradeN++;
    if (!d.riskGovernor.approved) s.rgBlocks++;
    if (d.status === "SHADOW_WIN") { s.n++; s.wins++; s.sumR += d.pnlR ?? 0; }
    else if (d.status === "SHADOW_LOSS") { s.n++; s.losses++; s.sumR += d.pnlR ?? 0; }
  }
  const rows = Object.entries(byStrategy).map(([strategy, s]) => {
    const winRate = s.n ? s.wins / s.n : 0;
    const avgR = s.n ? s.sumR / s.n : 0;
    const profitFactor = s.losses ? Math.max(0, s.sumR + s.losses) / s.losses : s.wins;
    const expectancy = winRate * Math.max(0, avgR) - (1 - winRate) * 1;
    const riskAdj = s.n ? avgR / Math.max(0.5, Math.sqrt(s.n)) : 0;
    return {
      strategy, sample: s.n, winRate: Number((winRate * 100).toFixed(1)),
      avgR: Number(avgR.toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      expectancy: Number(expectancy.toFixed(2)),
      riskAdjustedReturn: Number(riskAdj.toFixed(2)),
      qualitySetups: s.n,
      confidenceAccuracy: confidenceAccuracyFor(strategy),
      riskDiscipline: Math.max(0, 100 - Math.round((s.rgBlocks / Math.max(1, s.n + s.rgBlocks)) * 100)),
      tradeGradeAvg: Number((s.gradeSum / Math.max(1, s.gradeN)).toFixed(2)),
    };
  }).sort((a, b) => b.expectancy - a.expectancy);
  // Audit rank 70: `bestScalping` (/scalp/i) and `bestGold` (/gold/i) matched
  // against strategy NAMES, none of which contain those words — they read "—"
  // forever. `bestOnGold` is now computed from the decision's SYMBOL instead,
  // which is a fact the decisions actually carry. There is no timeframe/holding
  // -period field on a shadow decision, so a "scalping" slot cannot be computed
  // at all and is not rendered rather than shown as a permanent dash.
  //
  // `bestForex` carried the SAME name-regex defect and was missed: it matched
  // /pullback|trend|break/i against the strategy name, and four of the seven
  // engine strategies ("Trend Continuation", "Break of Structure", "Pullback
  // Continuation", "Session Breakout") match it — so a sample containing only
  // XAUUSD or BTCUSD decisions still filled a card labelled BEST FOREX with a
  // strategy that had never traded a currency pair. Worse than the two slots it
  // sat beside, because those at least rendered an honest "—". It is now
  // derived from the decision's symbol through the ARX market registry, the
  // same way gold is.
  const goldRows = rankByStrategyOverDecisions(arr.filter((d) => isGoldSymbol(d.symbol)));
  const forexRows = rankByStrategyOverDecisions(arr.filter((d) => isForexSymbol(d.symbol)));
  const leaderboard = {
    bestOverall: rows[0]?.strategy ?? null,
    bestLowRisk: [...rows].sort((a, b) => b.riskDiscipline - a.riskDiscipline)[0]?.strategy ?? null,
    bestOnGold: goldRows[0] ?? null,
    bestOnForex: forexRows[0] ?? null,
    worst: rows.at(-1)?.strategy ?? null,
    toRetire: rows.find((r) => r.expectancy < 0 && r.sample >= 10)?.strategy ?? null,
  };
  return {
    running: tournamentEnabled, startedAt: tournamentStartedAt, ranked: rows, leaderboard,
    notComputed: {
      bestScalping: "Not computed — a shadow decision carries no holding-period or timeframe-class field, so a scalping category cannot be derived.",
    },
    dataSource: "SHADOW" as const,
  };
}

// ── Confidence Calibration ────────────────────────────────────────────────
//
// Audit rank 66: the verdict never compared predicted confidence to observed
// win rate. It computed slope = highBucketWinRate − lowBucketWinRate and
// returned WELL_CALIBRATED for any slope > 15, so a model whose 90-100% bucket
// won 45% and whose 50-60% bucket won 20% was labelled green WELL_CALIBRATED.
// That is monotonicity, not calibration.
//
// This now computes a real, sample-weighted calibration error — the mean
// |bucket midpoint − observed win rate| across buckets that have samples — and
// labels from THAT, checking absolute accuracy before any ordering shortcut.
//
// The samples come from shadow decisions on synthetic simulator candles, so the
// good-calibration label is CALIBRATED_ON_SYNTHETIC_ONLY: it never carries a
// bare "WELL_CALIBRATED" that reads as evidence the confidence numbers can be
// trusted as probabilities in the real market.
export type CalibrationLabel =
  | "CALIBRATED_ON_SYNTHETIC_ONLY" | "OVERCONFIDENT" | "UNDERCONFIDENT"
  | "RANDOM_CONFIDENCE" | "NEEDS_MORE_DATA";

/** Calibration error at or below this (percentage points) counts as calibrated. */
export const CALIBRATION_ERROR_TOLERANCE_PCTPTS = 10;
export const MIN_CALIBRATION_SAMPLE = 20;

/**
 * The labelling rule, isolated so it can be tested directly against the exact
 * counterexample the audit raised: a model whose 90-100% bucket wins 45% and
 * whose 50-60% bucket wins 20% has a monotonic slope of +25 and used to be
 * labelled WELL_CALIBRATED — while being wrong by ~40 points about every
 * probability it stated.
 *
 * `signedErrorPctPts` is claimed minus observed: positive ⇒ the model promised
 * more than it delivered.
 */
export function labelCalibration(args: {
  sample: number;
  calibrationErrorPctPts: number | null;
  signedErrorPctPts: number | null;
  slopePctPts: number;
}): CalibrationLabel {
  const { sample, calibrationErrorPctPts, signedErrorPctPts, slopePctPts } = args;
  if (sample < MIN_CALIBRATION_SAMPLE) return "NEEDS_MORE_DATA";
  if (calibrationErrorPctPts == null || signedErrorPctPts == null) return "NEEDS_MORE_DATA";
  // ABSOLUTE accuracy first. Ordering is checked only after the model has been
  // shown to be wrong about the probabilities themselves.
  if (calibrationErrorPctPts <= CALIBRATION_ERROR_TOLERANCE_PCTPTS) return "CALIBRATED_ON_SYNTHETIC_ONLY";
  if (Math.abs(slopePctPts) < 5) return "RANDOM_CONFIDENCE";
  return signedErrorPctPts > 0 ? "OVERCONFIDENT" : "UNDERCONFIDENT";
}

export function confidenceCalibration() {
  const arr = [...decisions.values()].filter((d) => d.status === "SHADOW_WIN" || d.status === "SHADOW_LOSS");
  const buckets = [
    { label: "50-60", min: 50, max: 60 }, { label: "60-70", min: 60, max: 70 },
    { label: "70-80", min: 70, max: 80 }, { label: "80-90", min: 80, max: 90 },
    { label: "90-100", min: 90, max: 101 },
  ];
  const out = buckets.map((b) => {
    const xs = arr.filter((d) => d.confidence >= b.min && d.confidence < b.max);
    const wins = xs.filter((d) => d.status === "SHADOW_WIN").length;
    const winRate = xs.length ? wins / xs.length : 0;
    const avgR = xs.length ? xs.reduce((a, d) => a + (d.pnlR ?? 0), 0) / xs.length : 0;
    // What the confidence number CLAIMS: the midpoint of the bucket it fell in.
    const expectedWinRate = (b.min + Math.min(100, b.max)) / 2;
    return {
      bucket: b.label, sample: xs.length,
      winRate: Number((winRate * 100).toFixed(1)),
      expectedWinRate: Number(expectedWinRate.toFixed(1)),
      // Positive ⇒ claimed more than it delivered (overconfident in this bucket).
      errorPctPts: xs.length ? Number((expectedWinRate - winRate * 100).toFixed(1)) : null,
      avgR: Number(avgR.toFixed(2)),
    };
  });

  const populated = out.filter((b) => b.sample > 0);
  const totalPopulated = populated.reduce((a, b) => a + b.sample, 0);
  // Sample-weighted mean |error| and mean signed error, in percentage points.
  const calibrationErrorPctPts = totalPopulated
    ? Number((populated.reduce((a, b) => a + Math.abs(b.errorPctPts ?? 0) * b.sample, 0) / totalPopulated).toFixed(1))
    : null;
  const signedErrorPctPts = totalPopulated
    ? Number((populated.reduce((a, b) => a + (b.errorPctPts ?? 0) * b.sample, 0) / totalPopulated).toFixed(1))
    : null;

  const high = out.filter((b) => b.bucket === "80-90" || b.bucket === "90-100");
  const low = out.filter((b) => b.bucket === "50-60" || b.bucket === "60-70");
  const slope = avg(high.map((b) => b.winRate)) - avg(low.map((b) => b.winRate));

  const label = labelCalibration({
    sample: arr.length, calibrationErrorPctPts, signedErrorPctPts, slopePctPts: slope,
  });

  return {
    buckets: out,
    totalSample: arr.length,
    minSample: MIN_CALIBRATION_SAMPLE,
    label,
    calibrationErrorPctPts,
    signedErrorPctPts,
    tolerancePctPts: CALIBRATION_ERROR_TOLERANCE_PCTPTS,
    monotonicitySlopePctPts: Number(slope.toFixed(1)),
    method:
      "Sample-weighted mean |bucket midpoint − observed win rate| over buckets with samples. " +
      "Samples are SHADOW decisions resolved against synthetic simulator candles — never live fills.",
    dataSource: "SHADOW" as const,
    candleSource: "SYNTHETIC_SIMULATOR" as const,
  };
}
function avg(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function confidenceAccuracyFor(strategy: string): number {
  const arr = [...decisions.values()].filter((d) => d.strategy === strategy && (d.status === "SHADOW_WIN" || d.status === "SHADOW_LOSS"));
  if (!arr.length) return 0;
  const expectedWR = avg(arr.map((d) => d.confidence));
  const actualWR = (arr.filter((d) => d.status === "SHADOW_WIN").length / arr.length) * 100;
  return Math.max(0, Math.round(100 - Math.abs(expectedWR - actualWR)));
}

// ── Promotion / Demotion Gates ────────────────────────────────────────────
export type PromotionLevel = "TESTING" | "WATCHLIST" | "PAPER_APPROVED" | "DEMO_APPROVED" | "LIVE_INTENT_APPROVED" | "FUTURE_MT5_LIVE_LOCKED";
export type DemotionLevel = "WATCHLIST" | "NEEDS_REVIEW" | "PAUSED" | "RETIRED";

interface StrategyGate { strategy: string; level: PromotionLevel; demotion: DemotionLevel | null; updatedAt: string; lastReason: string }
const gates = new Map<string, StrategyGate>();
function getGate(strategy: string): StrategyGate {
  let g = gates.get(strategy);
  if (!g) { g = { strategy, level: "TESTING", demotion: null, updatedAt: new Date().toISOString(), lastReason: "init" }; gates.set(strategy, g); }
  return g;
}

function strategyStats(strategy: string) {
  const arr = [...decisions.values()].filter((d) => d.strategy === strategy);
  const tracked = arr.filter((d) => d.status === "SHADOW_WIN" || d.status === "SHADOW_LOSS");
  const wins = tracked.filter((d) => d.status === "SHADOW_WIN");
  const winRate = tracked.length ? wins.length / tracked.length : 0;
  const avgR = tracked.length ? tracked.reduce((a, d) => a + (d.pnlR ?? 0), 0) / tracked.length : 0;
  const dd = maxDrawdownR(arr);
  const rgViolations = arr.filter((d) => !d.riskGovernor.approved).length;
  const expectancy = winRate * Math.max(0, avgR) - (1 - winRate);
  return { sample: arr.length, tracked: tracked.length, winRate, avgR, drawdownR: dd, rgViolations, expectancy };
}

export function promotionStatus() {
  const strategies = new Set<string>([
    ...TOURNAMENT_STRATEGIES,
    ...Array.from(decisions.values()).map((d) => d.strategy),
  ]);
  return Array.from(strategies).map((s) => {
    const g = getGate(s); const st = strategyStats(s); const cal = confidenceCalibration();
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
    if (st.tracked >= 50 && st.expectancy > 0 && st.drawdownR <= 8 && (calLabel === "CALIBRATED_ON_SYNTHETIC_ONLY" || calLabel === "UNDERCONFIDENT")) return "DEMO_APPROVED";
    return null;
  }
  if (curr === "DEMO_APPROVED") {
    if (st.tracked >= 100 && st.expectancy > 0 && (calLabel === "CALIBRATED_ON_SYNTHETIC_ONLY") && st.rgViolations === 0) return "LIVE_INTENT_APPROVED";
    return null;
  }
  return null;
}
export function promote(strategy: string, by: string): { ok: boolean; gate?: StrategyGate; error?: string } {
  const g = getGate(strategy); const st = strategyStats(strategy); const cal = confidenceCalibration();
  const next = computeNextLevel(g.level, st, cal.label);
  if (!next) return { ok: false, error: `Strategy ${strategy} not eligible from ${g.level}` };
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
  const out: Array<{ strategy: string; suggested: DemotionLevel | null; reasons: string[] }> = [];
  for (const s of TOURNAMENT_STRATEGIES) {
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
    out.push({ strategy: s, suggested, reasons });
  }
  return out;
}

// ── AI Readiness Score ────────────────────────────────────────────────────
//
// Audit rank 46: three of the eleven scored factors were typed literals —
// overtradingBehavior: 100, learningLoopStability: 80, safetyCompliance: 100 —
// and the composite averaged all eleven equally, so ~27% of a readiness verdict
// on a live-trading system was invented, and it pulled the label upward. The
// page rendered them as progress bars identical to the measured ones.
//
// They are now EXCLUDED from the mean and reported separately as not measured,
// each with the reason and what would be needed to measure it. The score is
// explicitly `partial`. The remaining eight factors are still derived from
// shadow decisions on SYNTHETIC simulator candles — that provenance is returned
// too, so the page can say so rather than implying market evidence.
export const READINESS_NOT_MEASURED: Array<{ factor: string; reason: string; wouldNeed: string }> = [
  {
    factor: "overtradingBehavior",
    reason: "Was a typed constant (100). Nothing counts shadow decisions per unit time against a limit.",
    wouldNeed: "A decisions-per-window rate compared with the session's configured max-trades rule.",
  },
  {
    factor: "learningLoopStability",
    reason: "Was a typed constant (80). No learning-loop metric is read here.",
    wouldNeed: "Variance of the loop's parameter updates over time from the learning-events store.",
  },
  {
    factor: "safetyCompliance",
    reason: "Was a typed constant (100). Risk-Governor outcomes are already counted by riskDiscipline; no separate safety-gate audit is read.",
    wouldNeed: "A pass/violation count from the gate evaluator's audit trail for the same window.",
  },
];

export function readinessScore() {
  const all = [...decisions.values()];
  const tracked = all.filter((d) => d.status === "SHADOW_WIN" || d.status === "SHADOW_LOSS");
  const wins = tracked.filter((d) => d.status === "SHADOW_WIN").length;
  const wr = tracked.length ? wins / tracked.length : 0;
  const cal = confidenceCalibration();
  const calScore = cal.label === "CALIBRATED_ON_SYNTHETIC_ONLY" ? 100 : cal.label === "UNDERCONFIDENT" ? 75 : cal.label === "OVERCONFIDENT" ? 40 : cal.label === "RANDOM_CONFIDENCE" ? 20 : 30;
  const rgViolations = all.filter((d) => !d.riskGovernor.approved).length;
  const riskDiscipline = Math.max(0, 100 - Math.round((rgViolations / Math.max(1, all.length)) * 100));
  const ddR = maxDrawdownR(all);
  const ddScore = Math.max(0, 100 - Math.round(ddR * 8));
  const sample = Math.min(100, all.length);
  const grades = all.map((d) => d.grade); const avgGrade = grades.length ? avg(grades) * 10 : 0;

  // MEASURED factors only. Nothing typed, nothing defaulted.
  const factors = {
    strategyPerformance: Math.round(wr * 100),
    confidenceCalibration: calScore,
    riskDiscipline,
    drawdownBehavior: ddScore,
    tradeGradeAvg: Math.round(avgGrade),
    entrySniperAvg: Math.round(avg(all.map((d) => d.sniper))),
    opportunityScoreAccuracy: Math.round(avg(all.map((d) => d.opportunity))),
    sampleSize: sample,
  };
  const score = Math.round(avg(Object.values(factors)));
  const label = score < 50 ? "NOT_READY" : score < 70 ? "NEEDS_MORE_TESTING" : score < 85 ? "PAPER_READY" : score < 95 ? "DEMO_READY" : "LIVE_INTENT_READY";
  return {
    score, label, factors,
    partial: true as const,
    measuredFactorCount: Object.keys(factors).length,
    totalFactorCount: Object.keys(factors).length + READINESS_NOT_MEASURED.length,
    notMeasured: READINESS_NOT_MEASURED,
    basis:
      `Partial score: ${Object.keys(factors).length} of ` +
      `${Object.keys(factors).length + READINESS_NOT_MEASURED.length} factors are measured; ` +
      `${READINESS_NOT_MEASURED.length} are not measured and are excluded from the mean (they are not scored as 100). ` +
      "Every measured factor is derived from SHADOW decisions resolved against synthetic simulator " +
      "candles, so this is a self-consistency score on fabricated prices — not a live-readiness certification.",
    candleSource: "SYNTHETIC_SIMULATOR" as const,
    realBrokerReadiness: "Real broker readiness unavailable until MT5 bridge is connected.",
    dataSource: "SHADOW" as const,
  };
}

// ── Shadow Journal ────────────────────────────────────────────────────────
export function shadowJournal(limit = 200) {
  const arr = [...decisions.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, limit);
  return arr.map((d) => ({
    id: d.id, ts: d.ts, symbol: d.symbol, strategy: d.strategy, marketCondition: d.marketCondition,
    aiSaw: d.reason, whatHappened: d.outcomeAt ? `${d.status} (R=${d.pnlR ?? 0})` : d.status,
    rightOrWrong: d.status === "SHADOW_WIN" ? "RIGHT" : d.status === "SHADOW_LOSS" ? "WRONG" : "PENDING",
    lesson: lessonFor(d), dataSource: "SHADOW" as const,
  }));
}
function lessonFor(d: ShadowDecision): string {
  if (d.status === "SHADOW_LOSS" && d.confidence >= 80) return "High-confidence loss — recalibrate model";
  if (d.status === "SHADOW_WIN" && d.confidence < 60) return "Low-confidence win — model may be too cautious";
  if (d.status === "SHADOW_REJECTED") return `Risk Governor rejection: ${d.reasonToAvoid}`;
  if (d.status === "SHADOW_EXPIRED") return "Setup expired — entry timing too late or chop";
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
    forwardTest: forwardRunning ? { running: true, endsAt: forwardEndsAt } : { running: false },
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
