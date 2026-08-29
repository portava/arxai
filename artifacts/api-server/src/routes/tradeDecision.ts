// ═══════════════════════════════════════════════════════════════════════════
// (AA) Build AA — Trade Decision Orchestrator.
//
// One central decision endpoint that COMPOSES every available signal source
// into one structured TradeDecision. Replaces the open-loop pattern (user
// reads 8 pages and decides manually) with a single call:
//
//   POST /api/trade-decision/evaluate
//   POST /api/trade-decision/demo            (synthetic-input proof)
//   GET  /api/trade-decision/logs?limit=50
//   GET  /api/trade-decision/latest?symbol=
//
// SAFETY:
//   - 100% advisory. canPlaceTrades stays false; this route never touches
//     execute-trade / mt5_* / live_positions.
//   - When in doubt, returns HOLD.
//   - Writes only own table + vault audit. Reads everywhere else.
//   - Defaults to PAPER_TRADING mode unless safetyCore says otherwise.
//
// HONESTY:
//   - No "expected return," no "guaranteed profit." Every response carries
//     a disclaimer that this is decision support, not a profit promise.
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type Response } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { getOrCreateUserRiskSettings } from "../lib/risk/userRiskSettings.js";
import {
  db,
  tradeDecisionLogsTable,
  signalsTable,
  botSettingsTable,
  riskSettingsTable,
  riskLocksTable,
  paperOrdersTable,
  paperAccountsTable,
  traderSkillProfilesTable,
  analyticsSnapshotsTable,
  aiMentorSessionsTable,
  tradingReadinessChecksTable,
  edgeDiscoveryReportsTable,
  vaultEventsTable,
} from "@workspace/db";
import { desc, eq, and, isNull, or } from "drizzle-orm";
import {
  runStrategyScan,
  detectSession,
  computeMarketCondition,
  getMarketTypeForSymbol,
} from "../lib/strategyEngine";
import { getStatus as getSafetyStatus } from "../lib/safetyCore";
import { getMarketData, summarizeForAA, computeBlockers as computeMdBlockers } from "../lib/marketData/marketDataService.js";
import type { MarketDataSnapshot, MarketDataBlocker } from "../lib/marketData/types.js";

const router = Router();

const ORCH_DISCLAIMER =
  "This is decision SUPPORT, not a profit promise. The orchestrator advises only — it never places live trades. Past signals do not predict future results.";

function ok(res: Response, body: Record<string, unknown>) {
  return res.json({ ...body, system: "trade-decision", disclaimer: ORCH_DISCLAIMER });
}
function fail(res: Response, status: number, error: string) {
  return res.status(status).json({ error, system: "trade-decision", disclaimer: ORCH_DISCLAIMER });
}
async function vaultDecision(kind: string, severity: "INFO"|"WARN"|"DANGER", payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity, source: "SYSTEM", truthDomain: "DECISION",
    summary: kind, payload: { ...payload, orchestrator: "AA" },
    reasons: [], blockers: [], generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

// ── Decision object shape ───────────────────────────────────────────────────
export interface SignalScore {
  source: string;
  status: "PASS" | "WARN" | "FAIL" | "INFO" | "MISSING";
  score: number; // 0..100 contribution to confidence; negative scores discouraged
  detail: string;
}
export interface TradeDecision {
  shouldTrade: boolean;
  action: "BUY" | "SELL" | "HOLD";
  symbol: string;
  confidence: number;            // 0..100
  riskScore: number;             // 0..100 (higher = more dangerous)
  entryReason: string;
  invalidationReason: string;
  stopLoss: number | null;
  takeProfit: number | null;
  positionSize: number | null;
  tradeWindow: { status: "GOOD" | "WAIT" | "AVOID"; reason: string };
  signalsUsed: SignalScore[];
  warnings: string[];
  blockers: string[];
  operationalMode: string;
  syntheticData: boolean;
  timestamp: string;
  // Build CC — Learning feedback (read-only, additive, advisory).
  learningEdgeSummary?: string;
  edgeScoreUsed?: number;
  confidenceAdjustmentApplied?: number;
  riskAdjustmentApplied?: number;
  knownMistakeWarnings?: string[];
  learningSampleSize?: number;
  learningConfidence?: "LOW" | "MEDIUM" | "HIGH";
  // Build DD — Market data summary (read-only, advisory).
  marketDataSummary?: {
    source: string;
    provider: string;
    symbol: string;
    mid: number;
    spread: number;
    timestamp: string;
    timeframe: string;
    dataQualityStatus: string;
    candlesAvailable: number;
    volatilityLevel: string;
    liquidityLevel: string;
    warnings: string[];
    blockers: { reason: string; severity: string }[];
  };
}

// ── Synthetic candle fallback (mirrors strategyEngine demo mode) ───────────
interface SimpleCandle { time: string; open: number; high: number; low: number; close: number; volume: number }
function syntheticCandles(symbol: string, n = 100): SimpleCandle[] {
  const base = symbol.toLowerCase().includes("boom") ? 1100
             : symbol.toLowerCase().includes("crash") ? 950
             : 500;
  const out: SimpleCandle[] = [];
  let price = base;
  const start = Date.now() - n * 60_000;
  for (let i = 0; i < n; i++) {
    const drift = (Math.random() - 0.48) * (base * 0.002);
    const o = price;
    const c = price + drift;
    const h = Math.max(o, c) + Math.random() * (base * 0.001);
    const l = Math.min(o, c) - Math.random() * (base * 0.001);
    out.push({ time: new Date(start + i * 60_000).toISOString(), open: o, high: h, low: l, close: c, volume: 100 + Math.random() * 50 });
    price = c;
  }
  return out;
}

// ── Input schema for /evaluate ──────────────────────────────────────────────
const EvaluateBody = z.object({
  symbol: z.string().min(1).default("Volatility 75 Index"),
  // Optional: caller-provided candles; otherwise market-data service.
  candles: z.array(z.object({
    time: z.string(), open: z.number(), high: z.number(),
    low: z.number(), close: z.number(), volume: z.number().optional().default(0),
  })).optional(),
  // Optional override: caller can pass mode for what-if checks; default = read from safetyCore.
  proposedAction: z.enum(["AUTO", "BUY", "SELL"]).optional().default("AUTO"),
  // Build DD — TEST-ONLY market data quality injection (proves HOLD branches).
  // Never used by production callers; allows the verification suite to
  // simulate stale quotes, missing candles, or wide spreads without mocking
  // the provider layer.
  injectMarketIssue: z.enum(["NONE", "STALE", "MISSING", "WIDE_SPREAD", "EXTREME_VOLATILITY"]).optional().default("NONE"),
});

// ── Core orchestration ──────────────────────────────────────────────────────
export async function orchestrate(input: z.infer<typeof EvaluateBody>, userId: number): Promise<TradeDecision> {
  const symbol = input.symbol;
  const signalsUsed: SignalScore[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  // 1) Safety core — terminal authority. Never bypassable.
  const safety = await getSafetyStatus().catch(() => null);
  const operationalMode = safety?.operationalMode ?? "PAPER_TRADING";
  if (safety?.killSwitchEngaged) {
    blockers.push(`Kill switch engaged: ${safety.killSwitchReason ?? "no reason"}`);
    signalsUsed.push({ source: "safetyCore", status: "FAIL", score: 0, detail: "Kill switch ENGAGED — only OBSERVE_ONLY allowed" });
  } else if (!safety) {
    warnings.push("Safety core unreachable — defaulting to PAPER_TRADING posture");
    signalsUsed.push({ source: "safetyCore", status: "MISSING", score: 0, detail: "Safety core unreachable" });
  } else {
    signalsUsed.push({ source: "safetyCore", status: "PASS", score: 10, detail: `Mode=${operationalMode}, allowed=[${safety.allowedModes.join("|")}]` });
  }

  // 2) Strategy signal — primary directional input.
  // Build DD — Market data is now sourced from the unified read-only
  // marketDataService. If the caller passes candles directly we honor them
  // (back-compat for existing tests); otherwise the service decides
  // REAL vs FALLBACK and reports blockers we feed straight into AA.
  let chosenStrategySignal: Awaited<ReturnType<typeof runStrategyScan>> | null = null;
  let mdSnapshot: MarketDataSnapshot | null = null;
  let mdBlockers: MarketDataBlocker[] = [];
  let candles: SimpleCandle[];
  if (input.candles) {
    candles = input.candles;
  } else {
    const md = await getMarketData({ symbol, timeframe: "M5", limit: 100 });
    mdSnapshot = md.snapshot;
    mdBlockers = md.blockers;

    // TEST-ONLY: simulate degraded market data conditions to prove HOLD branches.
    if (input.injectMarketIssue === "STALE") {
      mdSnapshot.timestamp = new Date(Date.now() - 5 * 60_000).toISOString();
      mdBlockers = computeMdBlockers(mdSnapshot);
    } else if (input.injectMarketIssue === "MISSING") {
      mdSnapshot.candles = mdSnapshot.candles.slice(0, 5);
      mdSnapshot.dataQuality.candlesAvailable = mdSnapshot.candles.length;
      mdSnapshot.dataQuality.status = "MISSING";
      mdBlockers = computeMdBlockers(mdSnapshot);
    } else if (input.injectMarketIssue === "WIDE_SPREAD") {
      mdSnapshot.spread = mdSnapshot.mid * 0.05; // 5% — way over 1% cap
      mdSnapshot.bid = mdSnapshot.mid - mdSnapshot.spread / 2;
      mdSnapshot.ask = mdSnapshot.mid + mdSnapshot.spread / 2;
      mdBlockers = computeMdBlockers(mdSnapshot);
    } else if (input.injectMarketIssue === "EXTREME_VOLATILITY") {
      mdSnapshot.sessionContext.volatilityLevel = "EXTREME";
      mdBlockers = computeMdBlockers(mdSnapshot);
    }

    candles = mdSnapshot.candles.map((c) => ({
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    }));
    // Convert market-data blockers into AA blockers/warnings.
    for (const b of mdBlockers) {
      if (!b.blocked) continue;
      if (b.severity === "CRITICAL" || b.severity === "HIGH") {
        blockers.push(`Market data: ${b.reason}`);
      } else {
        warnings.push(`Market data: ${b.reason}`);
      }
    }
    signalsUsed.push({
      source: "marketData",
      status: mdBlockers.some((b) => b.blocked && (b.severity === "CRITICAL" || b.severity === "HIGH")) ? "FAIL"
            : mdBlockers.some((b) => b.blocked) ? "WARN"
            : "PASS",
      score: mdBlockers.some((b) => b.blocked) ? 0 : 5,
      detail: `${mdSnapshot.source}/${mdSnapshot.provider} mid=${mdSnapshot.mid} spread=${mdSnapshot.spread} vol=${mdSnapshot.sessionContext.volatilityLevel} q=${mdSnapshot.dataQuality.status}`,
    });
  }
  const syntheticData = input.candles == null && (mdSnapshot?.source !== "REAL");
  try {
    const marketType = getMarketTypeForSymbol(symbol);
    chosenStrategySignal = runStrategyScan(symbol, candles, 65, marketType);
    if (chosenStrategySignal) {
      const conf = chosenStrategySignal.confidence ?? 0;
      signalsUsed.push({
        source: "strategyEngine",
        status: conf >= 70 ? "PASS" : conf >= 50 ? "WARN" : "FAIL",
        score: Math.min(40, conf * 0.4),
        detail: `${chosenStrategySignal.strategy} → ${chosenStrategySignal.direction} @ conf ${conf}`,
      });
    } else {
      signalsUsed.push({ source: "strategyEngine", status: "INFO", score: 0, detail: "No strategy fired (HOLD)" });
    }
  } catch (err) {
    warnings.push(`Strategy engine error: ${String(err)}`);
    signalsUsed.push({ source: "strategyEngine", status: "MISSING", score: 0, detail: `Engine threw: ${String(err)}` });
  }

  // 3) Market / session context.
  const session = detectSession();
  const marketCondition = computeMarketCondition(candles);
  if (session === "Closed") {
    blockers.push("Session closed — no trades during dead session window");
    signalsUsed.push({ source: "session", status: "FAIL", score: 0, detail: `Session=${session}` });
  } else {
    signalsUsed.push({ source: "session", status: "PASS", score: 5, detail: `Session=${session}, market=${marketCondition}` });
  }
  if (/abnormal|extreme/i.test(marketCondition)) {
    warnings.push(`Market condition is ${marketCondition} — elevated risk`);
  }

  // 4) Risk settings (per-user) + active risk locks.
  // Locks: this trader's own PLUS the operator-created platform locks, which
  // routes/permission.ts deliberately writes with a NULL owner. Narrowing to
  // `eq(userId)` alone would silently drop a platform-wide hold — this repo
  // never removes a stop.
  const [risk, locks] = await Promise.all([
    getOrCreateUserRiskSettings(userId),
    db.select().from(riskLocksTable).where(and(
      or(isNull(riskLocksTable.userId), eq(riskLocksTable.userId, userId)),
      eq(riskLocksTable.isActive, true),
    )),
  ]);
  const minConfidence = risk?.minConfidenceScore ?? 75;
  if (locks.length > 0) {
    for (const l of locks) blockers.push(`Risk lock active: ${l.lockType} — ${l.reason}`);
    signalsUsed.push({ source: "riskLocks", status: "FAIL", score: 0, detail: `${locks.length} active lock(s)` });
  } else {
    signalsUsed.push({ source: "riskLocks", status: "PASS", score: 5, detail: "No active locks" });
  }
  if (risk?.liveLocked) warnings.push("Live trading is locked in risk settings");

  // 5) Account + open-position context (paper account is always available).
  // ISOLATION: `openCount` is compared against THIS trader's maxOpenTrades a
  // few lines below. Unscoped, every other user's open paper orders counted
  // against this trader's cap, so a busy instance blocked everyone.
  const [paperAccts, openTrades] = await Promise.all([
    db.select().from(paperAccountsTable)
      .where(and(eq(paperAccountsTable.userId, userId),
                 eq(paperAccountsTable.isActive, 1)))
      .orderBy(desc(paperAccountsTable.id)).limit(1),
    db.select().from(paperOrdersTable)
      .where(and(eq(paperOrdersTable.userId, userId),
                 eq(paperOrdersTable.status, "OPEN"))),
  ]);
  const paperAcct = paperAccts[0] ?? null;
  const openCount = openTrades.length;
  if (risk && openCount >= risk.maxOpenTrades) {
    blockers.push(`Max open trades reached (${openCount} / ${risk.maxOpenTrades})`);
    signalsUsed.push({ source: "openPositions", status: "FAIL", score: 0, detail: `${openCount} open ≥ cap` });
  } else {
    signalsUsed.push({ source: "openPositions", status: "PASS", score: 5, detail: `${openCount} open trade(s)` });
  }

  // 6) Recent trade history — overtrading + revenge guard.
  // ISOLATION: the revenge guard trips on `losingStreak` and the overtrading
  // check counts `todays`. Read unscoped, both were computed from strangers'
  // trades — a trader could be told "Losing streak guard tripped (3 losses in
  // a row)" having placed no trades at all.
  const recent = await db.select().from(paperOrdersTable)
    .where(eq(paperOrdersTable.userId, userId))
    .orderBy(desc(paperOrdersTable.id)).limit(20);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const todays = recent.filter((o) => o.openedAt && o.openedAt >= today);
  const losingStreak = (() => {
    let s = 0;
    for (const o of recent) {
      if (o.status === "OPEN" || o.exitPrice == null) continue;
      const dir = o.direction === "BUY" ? 1 : -1;
      const pnl = (o.exitPrice - o.entryPrice) * dir;
      if (pnl < 0) s++; else break;
    }
    return s;
  })();
  if (risk && todays.length >= risk.maxTradesPerDay) {
    blockers.push(`Daily trade cap hit (${todays.length} / ${risk.maxTradesPerDay}) — overtrading guard`);
    signalsUsed.push({ source: "overtrading", status: "FAIL", score: 0, detail: `Today=${todays.length}` });
  } else {
    signalsUsed.push({ source: "overtrading", status: "PASS", score: 5, detail: `Today=${todays.length}` });
  }
  if (risk && losingStreak >= risk.stopAfterLosingStreak) {
    blockers.push(`Losing streak guard tripped (${losingStreak} losses in a row) — revenge-trade prevention`);
    signalsUsed.push({ source: "revengeGuard", status: "FAIL", score: 0, detail: `Losing streak ${losingStreak}` });
  } else if (losingStreak >= 2) {
    warnings.push(`Losing streak: ${losingStreak} — proceed with caution`);
    signalsUsed.push({ source: "revengeGuard", status: "WARN", score: 0, detail: `Losing streak ${losingStreak}` });
  } else {
    signalsUsed.push({ source: "revengeGuard", status: "PASS", score: 5, detail: `Losing streak ${losingStreak}` });
  }

  // 7) AI confidence score from latest analytics snapshot + skill profile.
  //
  // ISOLATION: every one of these five tables is per-trader. Read unscoped
  // (`.orderBy(desc(...)).limit(1)` with no predicate) they returned whichever
  // row ANY user wrote most recently, and the copy below then told this trader
  // `${symbol} is your WEAKEST symbol` and scored their decision against a
  // stranger's discipline score, mentor flag and readiness status. `userId` is
  // already a parameter of orchestrate() — it is now actually used.
  const [snapRows, skillRows, mentorRows, readinessRows, edgeRows] = await Promise.all([
    db.select().from(analyticsSnapshotsTable)
      .where(eq(analyticsSnapshotsTable.userId, userId))
      .orderBy(desc(analyticsSnapshotsTable.createdAt)).limit(1),
    db.select().from(traderSkillProfilesTable)
      .where(eq(traderSkillProfilesTable.userId, userId))
      .orderBy(desc(traderSkillProfilesTable.updatedAt)).limit(1),
    db.select().from(aiMentorSessionsTable)
      .where(eq(aiMentorSessionsTable.userId, userId))
      .orderBy(desc(aiMentorSessionsTable.createdAt)).limit(1),
    db.select().from(tradingReadinessChecksTable)
      .where(eq(tradingReadinessChecksTable.userId, userId))
      .orderBy(desc(tradingReadinessChecksTable.id)).limit(1),
    db.select().from(edgeDiscoveryReportsTable)
      .where(and(eq(edgeDiscoveryReportsTable.userId, userId),
                 eq(edgeDiscoveryReportsTable.symbol, symbol))).limit(5),
  ]);
  const snap = snapRows[0] ?? null;
  const skill = skillRows[0] ?? null;
  const mentor = mentorRows[0] ?? null;
  const readiness = readinessRows[0] ?? null;

  if (snap) {
    if (snap.weakestStrategy && chosenStrategySignal && snap.weakestStrategy === symbol) {
      warnings.push(`Analytics: ${symbol} is your WEAKEST symbol (PF=${snap.profitFactor.toFixed(2)})`);
      signalsUsed.push({ source: "analytics", status: "WARN", score: 0, detail: `${symbol} weakest by P&L` });
    } else if (snap.strongestStrategy === symbol) {
      signalsUsed.push({ source: "analytics", status: "PASS", score: 10, detail: `${symbol} strongest by P&L` });
    } else {
      signalsUsed.push({ source: "analytics", status: "INFO", score: 5, detail: `Net P&L=${snap.netProfitLoss.toFixed(2)}, PF=${snap.profitFactor.toFixed(2)}` });
    }
  } else {
    signalsUsed.push({ source: "analytics", status: "MISSING", score: 0, detail: "No analytics snapshot yet" });
  }

  if (skill) {
    const sl = skill.skillLevel;
    const disc = skill.disciplineScore;
    if (disc < 40) {
      warnings.push(`Discipline score low (${disc.toFixed(0)}/100) — tighten thresholds`);
      signalsUsed.push({ source: "skill", status: "WARN", score: 0, detail: `${sl}, disc=${disc.toFixed(0)}` });
    } else {
      signalsUsed.push({ source: "skill", status: "PASS", score: Math.min(10, disc / 10), detail: `${sl}, disc=${disc.toFixed(0)}` });
    }
  } else {
    signalsUsed.push({ source: "skill", status: "MISSING", score: 0, detail: "No skill profile yet" });
  }

  if (mentor) {
    if (mentor.sessionType === "RISK_WARNING" || mentor.sessionType === "DISCIPLINE_CHECK") {
      blockers.push(`AI mentor flagged: ${mentor.sessionType} — "${mentor.mainFocus}"`);
      signalsUsed.push({ source: "mentor", status: "FAIL", score: 0, detail: mentor.sessionType });
    } else {
      signalsUsed.push({ source: "mentor", status: "PASS", score: 5, detail: `${mentor.sessionType}: ${mentor.mainFocus.slice(0, 60)}` });
    }
  } else {
    signalsUsed.push({ source: "mentor", status: "MISSING", score: 0, detail: "No mentor session yet" });
  }

  if (readiness) {
    if (readiness.status === "LOCKED" || readiness.status === "NOT_READY") {
      blockers.push(`Trading readiness: ${readiness.status} (${readiness.readinessScore.toFixed(0)}/100)`);
      signalsUsed.push({ source: "readiness", status: "FAIL", score: 0, detail: readiness.status });
    } else if (readiness.status === "CAUTION") {
      warnings.push(`Trading readiness: CAUTION (${readiness.readinessScore.toFixed(0)}/100)`);
      signalsUsed.push({ source: "readiness", status: "WARN", score: 0, detail: readiness.status });
    } else {
      signalsUsed.push({ source: "readiness", status: "PASS", score: 5, detail: readiness.status });
    }
  } else {
    signalsUsed.push({ source: "readiness", status: "MISSING", score: 0, detail: "No readiness check today" });
  }

  // 8) Per-symbol edge confidence (Build W).
  if (edgeRows.length > 0) {
    const top = edgeRows.sort((a, b) => b.confidenceScore - a.confidenceScore)[0]!;
    if (top.confidenceScore < 40) {
      warnings.push(`Edge for ${symbol} is weak (${top.confidenceScore.toFixed(0)}/100)`);
      signalsUsed.push({ source: "edge", status: "WARN", score: 0, detail: `${top.edgeName} conf=${top.confidenceScore.toFixed(0)}` });
    } else {
      signalsUsed.push({ source: "edge", status: "PASS", score: Math.min(10, top.confidenceScore / 10), detail: `${top.edgeName} conf=${top.confidenceScore.toFixed(0)}` });
    }
  } else {
    signalsUsed.push({ source: "edge", status: "MISSING", score: 0, detail: "No edge report for this symbol" });
  }

  // 9) Latest persisted signal (cross-check with strategy engine).
  const latestSignals = await db.select().from(signalsTable)
    .where(eq(signalsTable.symbol, symbol)).orderBy(desc(signalsTable.id)).limit(1);
  const latestSig = latestSignals[0] ?? null;
  if (latestSig) {
    signalsUsed.push({ source: "signalsTable", status: "INFO", score: 0, detail: `Last signal=${latestSig.direction} conf=${latestSig.confidence}` });
  }

  // 9b) Build CC — Learning feedback memory (READ-ONLY, ADVISORY).
  // Pulls per-symbol+action edge memory and mistake patterns. Bounded
  // adjustments only; CANNOT bypass blockers or kill switch.
  const learningView = await (async () => {
    try {
      const { getSymbolLearningView } = await import("../lib/learningEngine.js");
      const probeAction = chosenStrategySignal?.direction === "BUY" ? "BUY"
                       : chosenStrategySignal?.direction === "SELL" ? "SELL" : "HOLD";
      let v = await getSymbolLearningView(symbol, probeAction);
      // Fallback: if HOLD probe found nothing, sample BUY/SELL to surface
      // historical bias for this symbol so the user can still see the data.
      if (v.totalSampleSize === 0 && probeAction === "HOLD") {
        const [buyV, sellV] = await Promise.all([
          getSymbolLearningView(symbol, "BUY"),
          getSymbolLearningView(symbol, "SELL"),
        ]);
        v = buyV.totalSampleSize >= sellV.totalSampleSize ? buyV : sellV;
      }
      return v;
    } catch (err) {
      warnings.push(`Learning engine unreachable (non-fatal): ${String(err).slice(0, 80)}`);
      return null;
    }
  })();
  if (learningView && learningView.totalSampleSize > 0) {
    signalsUsed.push({
      source: "learningEngine",
      status: learningView.edgeScoreUsed > 0 ? "PASS" : learningView.edgeScoreUsed < 0 ? "WARN" : "INFO",
      score: 0, // do not double-count: confidence/risk adjustments are applied below
      detail: learningView.edgeSummary,
    });
    if (learningView.knownMistakeWarnings.length > 0) {
      warnings.push(`Learning: ${learningView.knownMistakeWarnings.length} known mistake pattern(s) on ${symbol} ${chosenStrategySignal?.direction ?? "AUTO"}`);
    }
  } else {
    signalsUsed.push({ source: "learningEngine", status: "MISSING", score: 0, detail: "No prior learning samples for this symbol+action" });
  }

  // 10) Compose final scores.
  const baseConfidence = signalsUsed.reduce((sum, s) => sum + (s.score > 0 ? s.score : 0), 0);
  let confidence = Math.min(100, Math.max(0, baseConfidence));
  // Risk score: warnings + blockers + missing-data penalty, capped 0..100.
  const missingCount = signalsUsed.filter((s) => s.status === "MISSING").length;
  const failCount    = signalsUsed.filter((s) => s.status === "FAIL").length;
  const warnCount    = warnings.length;
  let riskScore = Math.min(100, failCount * 25 + warnCount * 10 + missingCount * 5);

  // Apply Build CC bounded adjustments (additive — safety still dominates).
  if (learningView && learningView.totalSampleSize > 0) {
    confidence = Math.min(100, Math.max(0, confidence + learningView.confidenceAdjustmentApplied));
    riskScore  = Math.min(100, Math.max(0, riskScore  + learningView.riskAdjustmentApplied));
  }

  // 11) Direction & invalidation rules.
  let action: "BUY" | "SELL" | "HOLD" = "HOLD";
  let entryReason = "Default HOLD — no qualifying signal.";
  let invalidationReason = "";

  // Required: a strategy signal that fired AND no blockers AND confidence >= floor.
  if (blockers.length > 0) {
    action = "HOLD";
    invalidationReason = blockers.join("; ");
  } else if (!chosenStrategySignal || chosenStrategySignal.direction === "WAIT") {
    action = "HOLD";
    invalidationReason = "No directional strategy signal fired — engine returned WAIT.";
  } else if (confidence < minConfidence) {
    action = "HOLD";
    invalidationReason = `Confidence ${confidence.toFixed(0)} below minimum ${minConfidence}.`;
  } else if (riskScore >= 70) {
    action = "HOLD";
    invalidationReason = `Risk score ${riskScore} too high — too many warnings/blockers.`;
  } else if (input.proposedAction !== "AUTO" && chosenStrategySignal.direction !== input.proposedAction) {
    action = "HOLD";
    invalidationReason = `Caller proposed ${input.proposedAction} but strategy signal is ${chosenStrategySignal.direction}.`;
  } else {
    action = chosenStrategySignal.direction === "BUY" ? "BUY" : "SELL";
    entryReason = `${chosenStrategySignal.strategy} fired ${action} on ${session} session in ${marketCondition} market with composite confidence ${confidence.toFixed(0)}/100. Risk score ${riskScore}/100.`;
    invalidationReason = `Invalidate if price closes ${action === "BUY" ? "below" : "above"} ${chosenStrategySignal.stopLoss}, or if any active risk lock engages.`;
  }

  // 12) Trade window classification.
  let tradeWindow: TradeDecision["tradeWindow"];
  if (session === "Closed" || blockers.length > 0) {
    tradeWindow = { status: "AVOID", reason: blockers[0] ?? `Session=${session}` };
  } else if (warnCount > 0 || riskScore >= 40) {
    tradeWindow = { status: "WAIT", reason: warnings[0] ?? `Risk score ${riskScore}` };
  } else {
    tradeWindow = { status: "GOOD", reason: `${session} session, ${marketCondition}, no warnings` };
  }

  // 13) Position sizing — purely advisory, derived from risk settings.
  let positionSize: number | null = null;
  let stopLoss: number | null = null;
  let takeProfit: number | null = null;
  if (action !== "HOLD" && chosenStrategySignal && risk && paperAcct) {
    stopLoss = chosenStrategySignal.stopLoss;
    takeProfit = chosenStrategySignal.takeProfit;
    const stopDist = Math.abs(chosenStrategySignal.entryPrice - chosenStrategySignal.stopLoss);
    if (stopDist > 0) {
      const dollarRisk = paperAcct.equity * (risk.riskPerTradePct / 100);
      const rawLot = dollarRisk / (stopDist * 100); // synthetic $/pt
      positionSize = Math.min(risk.maxLotSize, Math.max(0.01, Number(rawLot.toFixed(2))));
    } else {
      positionSize = 0.01;
    }
  }

  const decision: TradeDecision = {
    shouldTrade: action !== "HOLD",
    action, symbol, confidence, riskScore,
    entryReason, invalidationReason,
    stopLoss, takeProfit, positionSize,
    tradeWindow,
    signalsUsed, warnings, blockers,
    operationalMode, syntheticData,
    timestamp: new Date().toISOString(),
    // Build CC — additive learning fields (safe defaults if unavailable).
    learningEdgeSummary:         learningView?.edgeSummary ?? "No learning data available.",
    edgeScoreUsed:               learningView?.edgeScoreUsed ?? 0,
    confidenceAdjustmentApplied: learningView?.confidenceAdjustmentApplied ?? 0,
    riskAdjustmentApplied:       learningView?.riskAdjustmentApplied ?? 0,
    knownMistakeWarnings:        learningView?.knownMistakeWarnings ?? [],
    learningSampleSize:          learningView?.totalSampleSize ?? 0,
    learningConfidence:          learningView?.learningConfidence ?? "LOW",
    // Build DD — Market data summary (read-only, advisory).
    marketDataSummary:           mdSnapshot ? summarizeForAA(mdSnapshot, mdBlockers) : undefined,
  };
  return decision;
}

/**
 * OWNERSHIP: `userId` is required. `trade_decision_logs.user_id` is read back
 * per-user by the Risk Governor (collectMetrics reads decisions with
 * `eq(tradeDecisionLogsTable.userId, userId)`), so a decision written without
 * an owner is a decision no governor can ever see again — avgConfidence,
 * avgRiskScore and decisionToWinRate would sit at a confident 0 for every
 * trader. The orchestrator already resolves the caller; it passes it here.
 */
export async function persistDecision(d: TradeDecision, userId: number): Promise<number> {
  const ins = await db.insert(tradeDecisionLogsTable).values({
    userId,
    symbol: d.symbol, action: d.action, shouldTrade: d.shouldTrade,
    confidence: d.confidence, riskScore: d.riskScore,
    entryReason: d.entryReason, invalidationReason: d.invalidationReason,
    stopLoss: d.stopLoss, takeProfit: d.takeProfit, positionSize: d.positionSize,
    tradeWindowStatus: d.tradeWindow.status, tradeWindowReason: d.tradeWindow.reason,
    decisionJson: { signalsUsed: d.signalsUsed, warnings: d.warnings, blockers: d.blockers },
    operationalMode: d.operationalMode, syntheticData: d.syntheticData,
  }).returning({ id: tradeDecisionLogsTable.id });
  const id = ins[0]?.id ?? 0;
  const sev: "INFO"|"WARN"|"DANGER" = d.blockers.length > 0 ? "WARN" : d.shouldTrade ? "INFO" : "INFO";
  await vaultDecision("TRADE_DECISION_EVALUATED", sev, {
    decisionId: id, symbol: d.symbol, action: d.action, confidence: d.confidence,
    riskScore: d.riskScore, blockers: d.blockers.length, warnings: d.warnings.length,
  });
  return id;
}

// ── POST /trade-decision/evaluate ──────────────────────────────────────────
router.post("/trade-decision/evaluate", requireUser, async (req, res): Promise<void> => {
  try {
    const parsed = EvaluateBody.safeParse(req.body ?? {});
    if (!parsed.success) { fail(res, 400, "Invalid input: " + parsed.error.message); return; }
    const decision = await orchestrate(parsed.data, req.authUser!.id);
    const id = await persistDecision(decision, req.authUser!.id);
    ok(res, { decisionId: id, decision });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /trade-decision/evaluate failed");
    fail(res, 500, "Failed to evaluate trade decision");
  }
});

// ── POST /trade-decision/demo ──────────────────────────────────────────────
// Always runs with synthetic candles; used by tests and the UI's "Try it" button.
router.post("/trade-decision/demo", requireUser, async (req, res): Promise<void> => {
  try {
    const symbol = typeof req.body?.symbol === "string" ? req.body.symbol : "Volatility 75 Index";
    const decision = await orchestrate({ symbol, proposedAction: "AUTO", injectMarketIssue: "NONE" }, req.authUser!.id);
    const id = await persistDecision(decision, req.authUser!.id);
    ok(res, { decisionId: id, decision, demo: true });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "POST /trade-decision/demo failed");
    fail(res, 500, "Failed to run demo decision");
  }
});

// ── GET /trade-decision/logs ───────────────────────────────────────────────
// ISOLATION: a decision log carries the symbol, direction, confidence, stop
// and size the orchestrator produced for ONE trader. Unscoped, this listed
// every trader's decisions to every signed-in caller.
router.get("/trade-decision/logs", requireUser, async (req, res): Promise<void> => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query["limit"] ?? 50)));
    const rows = await db.select().from(tradeDecisionLogsTable)
      .where(eq(tradeDecisionLogsTable.userId, req.authUser!.id))
      .orderBy(desc(tradeDecisionLogsTable.id)).limit(limit);
    ok(res, { logs: rows, count: rows.length });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /trade-decision/logs failed");
    fail(res, 500, "Failed to load decision logs");
  }
});

// ── GET /trade-decision/latest?symbol= ─────────────────────────────────────
router.get("/trade-decision/latest", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const symbol = typeof req.query["symbol"] === "string" ? req.query["symbol"] : null;
    const q = symbol
      ? db.select().from(tradeDecisionLogsTable)
          .where(and(eq(tradeDecisionLogsTable.userId, userId),
                     eq(tradeDecisionLogsTable.symbol, symbol)))
          .orderBy(desc(tradeDecisionLogsTable.id)).limit(1)
      : db.select().from(tradeDecisionLogsTable)
          .where(eq(tradeDecisionLogsTable.userId, userId))
          .orderBy(desc(tradeDecisionLogsTable.id)).limit(1);
    const row = (await q)[0] ?? null;
    ok(res, { latest: row });
  } catch (err) {
    req.log?.error?.({ err: String(err) }, "GET /trade-decision/latest failed");
    fail(res, 500, "Failed to load latest decision");
  }
});

export default router;
