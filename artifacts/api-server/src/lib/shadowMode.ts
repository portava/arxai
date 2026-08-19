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
import { DEFAULT_SYMBOLS } from "./marketScanner.js";
import { buildForwardChartSeries, type ForwardChartSeries } from "./shadow/forwardChartSeries.js";
// shadowPersistence imports this module type-only, so no runtime cycle.
import {
  persistShadowDecision,
  updateShadowOutcome,
  SYNTHETIC_SIMULATOR_SOURCE,
} from "./shadowPersistence.js";

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
  marketCondition: string; action: "BUY" | "SELL" | "WAIT"; entry: number; sl: number; tp: number;
  confidence: number; opportunity: number; sniper: number; grade: number;
  riskGovernor: { approved: boolean; level: string; hardBlocks: string[]; warnings: string[] };
  reason: string; reasonToAvoid: string;
  status: ShadowStatus; expiresAt: string; pnlR?: number; outcomeAt?: string;
  dataSource: "SHADOW";
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

  const d: ShadowDecision = {
    id: newId(), ts: new Date().toISOString(), symbol, tf, strategy: scan.strategy,
    marketCondition: classifyMarket(symbol), action, entry, sl, tp,
    confidence: scan.confidence, opportunity: scan.confidence,
    sniper: Math.max(0, scan.confidence - 5), grade: Math.round(scan.confidence / 10),
    riskGovernor: { approved: rg.approved, level: rg.riskLevel, hardBlocks: rg.hardBlocks, warnings: rg.warnings },
    reason: scan.reason, reasonToAvoid: rg.hardBlocks.join("; ") || scan.riskWarning || "",
    status, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    dataSource: "SHADOW",
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
  return { running: false };
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

export function startForwardTest(c: Partial<ForwardTestConfig> = {}): { running: boolean; endsAt: string } {
  forwardConfig = {
    strategy: c.strategy, symbols: c.symbols ?? [...DEFAULT_SYMBOLS], timeframes: c.timeframes ?? ["M15"],
    durationMin: c.durationMin ?? 60, maxShadowTrades: c.maxShadowTrades ?? 100, maxTradesPerDay: c.maxTradesPerDay ?? 30,
    minConfidence: c.minConfidence ?? 60, minOpportunity: c.minOpportunity ?? 60, minTradeGrade: c.minTradeGrade ?? 6,
    riskProfile: c.riskProfile ?? "CONSERVATIVE",
    sessionFilters: c.sessionFilters ?? [], newsFilters: c.newsFilters ?? [],
  };
  forwardStartedAt = new Date().toISOString();
  forwardEndsAt = new Date(Date.now() + forwardConfig.durationMin * 60_000).toISOString();
  forwardCountAtStart = totalsObserved;
  if (!shadowEnabled) startShadowMode({ symbols: forwardConfig.symbols });
  return { running: true, endsAt: forwardEndsAt };
}
export function stopForwardTest() { const c = forwardConfig; forwardConfig = null; return { stopped: true, was: c }; }

export function forwardStatus() {
  return {
    running: !!forwardConfig, startedAt: forwardStartedAt, endsAt: forwardEndsAt,
    config: forwardConfig, observedSinceStart: totalsObserved - forwardCountAtStart,
    dataSource: "SHADOW" as const,
  };
}
export function forwardResults() {
  const since = forwardStartedAt ? Date.parse(forwardStartedAt) : 0;
  const arr = [...decisions.values()].filter((d) => Date.parse(d.ts) >= since &&
    (!forwardConfig?.strategy || d.strategy === forwardConfig.strategy));
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
  const since = forwardStartedAt ? Date.parse(forwardStartedAt) : 0;
  const arr = [...decisions.values()].filter((d) => Date.parse(d.ts) >= since &&
    (!forwardConfig?.strategy || d.strategy === forwardConfig.strategy));
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
export const TOURNAMENT_STRATEGIES = [
  "Conservative Pullback", "Trend Continuation", "Breakout Confirmation",
  "Liquidity Sweep Reversal", "Gold Scalping Test", "Custom Strategy",
];
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
  const leaderboard = {
    bestOverall: rows[0]?.strategy ?? null,
    bestLowRisk: [...rows].sort((a, b) => b.riskDiscipline - a.riskDiscipline)[0]?.strategy ?? null,
    bestScalping: rows.find((r) => /scalp/i.test(r.strategy))?.strategy ?? null,
    bestGold: rows.find((r) => /gold/i.test(r.strategy))?.strategy ?? null,
    bestForex: rows.find((r) => /pullback|trend|break/i.test(r.strategy))?.strategy ?? null,
    worst: rows.at(-1)?.strategy ?? null,
    toRetire: rows.find((r) => r.expectancy < 0 && r.sample >= 10)?.strategy ?? null,
  };
  return { running: tournamentEnabled, startedAt: tournamentStartedAt, ranked: rows, leaderboard, dataSource: "SHADOW" as const };
}

// ── Confidence Calibration ────────────────────────────────────────────────
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
    return { bucket: b.label, sample: xs.length, winRate: Number((winRate * 100).toFixed(1)), avgR: Number(avgR.toFixed(2)) };
  });
  let label: "WELL_CALIBRATED" | "OVERCONFIDENT" | "UNDERCONFIDENT" | "RANDOM_CONFIDENCE" | "NEEDS_MORE_DATA" = "NEEDS_MORE_DATA";
  if (arr.length >= 20) {
    const high = out.filter((b) => b.bucket === "80-90" || b.bucket === "90-100");
    const low = out.filter((b) => b.bucket === "50-60" || b.bucket === "60-70");
    const highWR = avg(high.map((b) => b.winRate));
    const lowWR = avg(low.map((b) => b.winRate));
    const slope = highWR - lowWR;
    if (Math.abs(slope) < 5) label = "RANDOM_CONFIDENCE";
    else if (slope > 15) label = "WELL_CALIBRATED";
    else if (highWR > 0 && highWR < 60) label = "OVERCONFIDENT";
    else label = "UNDERCONFIDENT";
  }
  return { buckets: out, totalSample: arr.length, label, dataSource: "SHADOW" as const };
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
export function readinessScore() {
  const all = [...decisions.values()];
  const tracked = all.filter((d) => d.status === "SHADOW_WIN" || d.status === "SHADOW_LOSS");
  const wins = tracked.filter((d) => d.status === "SHADOW_WIN").length;
  const wr = tracked.length ? wins / tracked.length : 0;
  const cal = confidenceCalibration();
  const calScore = cal.label === "WELL_CALIBRATED" ? 100 : cal.label === "UNDERCONFIDENT" ? 75 : cal.label === "OVERCONFIDENT" ? 40 : cal.label === "RANDOM_CONFIDENCE" ? 20 : 30;
  const rgViolations = all.filter((d) => !d.riskGovernor.approved).length;
  const riskDiscipline = Math.max(0, 100 - Math.round((rgViolations / Math.max(1, all.length)) * 100));
  const ddR = maxDrawdownR(all);
  const ddScore = Math.max(0, 100 - Math.round(ddR * 8));
  const sample = Math.min(100, all.length);
  const grades = all.map((d) => d.grade); const avgGrade = grades.length ? avg(grades) * 10 : 0;

  const factors = {
    strategyPerformance: Math.round(wr * 100),
    confidenceCalibration: calScore,
    riskDiscipline,
    drawdownBehavior: ddScore,
    overtradingBehavior: 100,
    tradeGradeAvg: Math.round(avgGrade),
    entrySniperAvg: Math.round(avg(all.map((d) => d.sniper))),
    opportunityScoreAccuracy: Math.round(avg(all.map((d) => d.opportunity))),
    sampleSize: sample,
    learningLoopStability: 80,
    safetyCompliance: 100,
  };
  const score = Math.round(avg(Object.values(factors)));
  const label = score < 50 ? "NOT_READY" : score < 70 ? "NEEDS_MORE_TESTING" : score < 85 ? "PAPER_READY" : score < 95 ? "DEMO_READY" : "LIVE_INTENT_READY";
  return {
    score, label, factors,
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
