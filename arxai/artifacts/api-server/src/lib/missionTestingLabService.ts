// ── Profit Mission Phase 9 — Testing Lab service (backtest + forward) ─────────
//
// SAFETY / SCOPE:
//   - COMPOSES the existing backtest engine (@workspace/domain/backtest +
//     backtestStrategyRegistry) and the pure Phase 9 testing-lab module to give a
//     mission a labelled diagnostic record. BACKTEST uses generated prices;
//     FORWARD aggregates the mission's OWN closed drafts without proving their
//     historical execution mode, account units or net costs. Results are persisted
//     append-only into `mission_test_results`.
//   - ADVISORY ONLY. Nothing here places a trade, touches the EA/broker, alters a
//     position, or relaxes/bypasses any live execution gate. Current diagnostic
//     producers cannot supply verification, promotion or strategy-drift evidence.
//   - Per-user / per-mission isolation: every read/write is scoped by (userId,
//     missionId). ARX Focus-Lock is enforced before a backtest runs.
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  profitMissionsTable,
  missionTestResultsTable,
  missionTradeDraftsTable,
} from "@workspace/db";
import {
  summarizeMissionTest,
  labelForKind,
  type MissionTestKind,
  type MissionTestMetrics,
  type MissionTestSummary,
  type MissionTestEvidence,
} from "@workspace/domain/profit-mission";
import {
  simulateBacktest,
  type BacktestCandle,
  type BacktestSignal,
} from "@workspace/domain/backtest";
import { resolveArxMarket, arxFocusBlockedEnvelope } from "@workspace/domain/market";
import {
  generateDeterministicCandles,
  runSingleStrategy,
  isKnownStrategyId,
  timeframeMs,
  type StrategyId,
} from "./backtestStrategyRegistry.js";
import type { Candle } from "./strategyEngine.js";
import {
  GENERATED_PRICE_EVIDENCE, CLOSED_DRAFT_EVIDENCE, backtestToMissionMetrics,
  projectMissionTestResult, roundMetric as round,
} from "./missionTestingEvidence.js";

const KNOWN_STRATEGIES = [
  "trendContinuation", "breakOfStructure", "liquiditySweep", "volatilityExpansion",
  "pullbackContinuation", "meanReversion", "sessionBreakout",
] as const;

type MissionRow = typeof profitMissionsTable.$inferSelect;

export interface MissionTestResultDto {
  id: number;
  missionId: number;
  kind: MissionTestKind;
  strategyKey: string;
  symbol: string;
  timeframe: string;
  label: string;
  sampleSize: number;
  sampleWarning: string | null;
  isVerified: boolean;
  metrics: MissionTestMetrics;
  headline: string;
  notes: string[];
  promotionEligible: boolean;
  createdAt: string;
  evidence: MissionTestEvidence;
}

export type TestingLabFailure =
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "unknown_strategy"; allowed: readonly string[] }
  | { ok: false; kind: "focus_blocked"; envelope: ReturnType<typeof arxFocusBlockedEnvelope> };

export type TestingLabResult =
  | { ok: true; result: MissionTestResultDto }
  | TestingLabFailure;

function clampFinite(n: number, max = 999): number {
  if (!Number.isFinite(n)) return max;
  return n;
}

async function loadOwnedMission(userId: number, missionId: number): Promise<MissionRow | null> {
  const rows = await db
    .select()
    .from(profitMissionsTable)
    .where(and(eq(profitMissionsTable.id, missionId), eq(profitMissionsTable.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

async function persistTestResult(args: {
  userId: number;
  missionId: number;
  kind: MissionTestKind;
  strategyKey: string;
  symbol: string;
  timeframe: string;
  metrics: MissionTestMetrics;
  summary: MissionTestSummary;
  experiment?: Record<string, unknown>;
}): Promise<MissionTestResultDto> {
  const inserted = await db
    .insert(missionTestResultsTable)
    .values({
      missionId: args.missionId,
      userId: args.userId,
      kind: args.kind,
      strategyKey: args.strategyKey,
      symbol: args.symbol,
      timeframe: args.timeframe,
      label: args.summary.label,
      sampleSize: args.summary.sampleSize,
      sampleWarning: args.summary.sampleWarning,
      metricsJson: {
        metrics: args.metrics,
        headline: args.summary.headline,
        notes: args.summary.notes,
        promotionEligible: args.summary.promotionEligible,
        evidence: args.summary.evidence,
        experiment: args.experiment ?? null,
      },
      isVerified: false,
    })
    .returning();
  return projectMissionTestResult(inserted[0]!);
}

export interface RunBacktestArgs {
  userId: number;
  missionId: number;
  strategyId: string;
  symbol: string;
  timeframe: string;
  candleCount?: number;
  minConfidence?: number;
  initialBalance?: number;
  seed?: string;
}

/**
 * Run a deterministic generated-price diagnostic for the mission's strategy and
 * persist an honest, labelled BACKTEST result. Focus-Lock + per-user scoped. The
 * result cannot satisfy the promotion gate or grant live permission.
 */
export async function runMissionBacktest(args: RunBacktestArgs): Promise<TestingLabResult> {
  const mission = await loadOwnedMission(args.userId, args.missionId);
  if (!mission) return { ok: false, kind: "not_found" };

  if (!isKnownStrategyId(args.strategyId)) {
    return { ok: false, kind: "unknown_strategy", allowed: KNOWN_STRATEGIES };
  }
  const focusMarket = resolveArxMarket(args.symbol);
  if (!focusMarket) {
    return { ok: false, kind: "focus_blocked", envelope: arxFocusBlockedEnvelope(args.symbol) };
  }

  const strategyId = args.strategyId as StrategyId;
  const candleCount = Math.min(5000, Math.max(50, Math.trunc(args.candleCount ?? 500)));
  const minConfidence = Math.min(100, Math.max(0, Math.trunc(args.minConfidence ?? 60)));
  const initialBalance = args.initialBalance && args.initialBalance > 0
    ? args.initialBalance
    : (mission.startingAmount > 0 ? mission.startingAmount : 10_000);
  const seed = args.seed ?? `${strategyId}|${args.symbol}|${args.timeframe}`;
  const baseTimeMs = Date.UTC(2024, 0, 1, 0, 0, 0);

  const candles: Candle[] = generateDeterministicCandles({
    symbol: args.symbol, count: candleCount, timeframe: args.timeframe, seed, baseTimeMs,
  });
  const signalFn = (window: BacktestCandle[]): BacktestSignal => {
    const sig = runSingleStrategy(strategyId, args.symbol, window as Candle[], minConfidence);
    return {
      direction: sig.direction, entryPrice: sig.entryPrice, stopLoss: sig.stopLoss,
      takeProfit: sig.takeProfit, confidence: sig.confidence, strategy: sig.strategy,
    };
  };

  const sim = simulateBacktest(args.symbol, candles, signalFn, initialBalance);
  const metrics = backtestToMissionMetrics(sim.metrics, sim.trades, initialBalance);
  const summary = summarizeMissionTest({
    kind: "BACKTEST", strategyKey: strategyId, symbol: args.symbol,
    timeframe: args.timeframe, metrics, evidence: GENERATED_PRICE_EVIDENCE,
  });

  // Anchor timeframe so the backtest window stays deterministic for the seed.
  void timeframeMs(args.timeframe);

  const result = await persistTestResult({
    userId: args.userId, missionId: args.missionId, kind: "BACKTEST",
    strategyKey: strategyId, symbol: args.symbol, timeframe: args.timeframe, metrics, summary,
    experiment: {
      version: 1, engine: "generated-price-diagnostic-v1", strategyId,
      seed, baseTimeMs, candleCount, minConfidence, initialBalance,
      symbol: args.symbol, timeframe: args.timeframe,
      costs: "not_modelled", chronologicalHoldout: "not_performed", pnlUnit: "price_units",
    },
  });
  return { ok: true, result };
}

export interface AggregateForwardArgs {
  userId: number;
  missionId: number;
  /** Exact optional source filter. Never relabel another strategy's outcomes. */
  strategyKey?: string;
  symbol?: string;
  timeframe?: string;
}

/**
 * Aggregate recorded outcomes from the mission's OWN closed drafts. Historical
 * execution mode, account units, costs and reconciliation are not established by
 * this table. Empty and partial-R samples stay explicit; no current aggregate
 * can satisfy promotion or become a verified strategy-drift baseline.
 */
export async function aggregateMissionForward(args: AggregateForwardArgs): Promise<TestingLabResult> {
  const mission = await loadOwnedMission(args.userId, args.missionId);
  if (!mission) return { ok: false, kind: "not_found" };

  const rows = await db
    .select({
      pnl: missionTradeDraftsTable.pnl,
      rMultiple: missionTradeDraftsTable.rMultiple,
      closedAt: missionTradeDraftsTable.closedAt,
      symbol: missionTradeDraftsTable.symbol,
      timeframe: missionTradeDraftsTable.timeframe,
      agentKey: missionTradeDraftsTable.agentKey,
    })
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.missionId, args.missionId),
        eq(missionTradeDraftsTable.userId, args.userId),
        eq(missionTradeDraftsTable.status, "executed"),
      ),
    )
    .orderBy(missionTradeDraftsTable.closedAt);

  const closed = rows.filter((r) => r.closedAt != null && r.pnl != null && Number.isFinite(r.pnl)
    && (args.strategyKey == null || r.agentKey === args.strategyKey)
    && (args.symbol == null || r.symbol === args.symbol)
    && (args.timeframe == null || r.timeframe === args.timeframe));
  const startingAmount = mission.startingAmount > 0 ? mission.startingAmount : 0;

  let winning = 0;
  let losing = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let sumR = 0;
  let rCount = 0;
  let winRSum = 0;
  let winRCount = 0;
  // Equity curve from realised P/L for an honest drawdown read.
  let equity = startingAmount;
  let peak = startingAmount;
  let maxDrawdownPct = 0;
  for (const r of closed) {
    const pnl = r.pnl as number;
    if (pnl > 0) { winning += 1; grossWin += pnl; }
    else if (pnl < 0) { losing += 1; grossLoss += Math.abs(pnl); }
    if (r.rMultiple != null && Number.isFinite(r.rMultiple)) {
      sumR += r.rMultiple; rCount += 1;
      if (r.rMultiple > 0) { winRSum += r.rMultiple; winRCount += 1; }
    }
    equity += pnl;
    if (equity > peak) peak = equity;
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100);
  }
  const total = closed.length;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);

  const metrics: MissionTestMetrics = {
    totalTrades: total,
    winningTrades: winning,
    losingTrades: losing,
    winRate: round(total > 0 ? winning / total : 0),
    netProfitLoss: round(grossWin - grossLoss, 2),
    maxDrawdownPct: round(Math.max(0, maxDrawdownPct), 2),
    averageRr: round(winRCount > 0 ? winRSum / winRCount : 0),
    expectancyR: round(rCount > 0 ? sumR / rCount : 0),
    profitFactor: round(clampFinite(profitFactor), 3),
  };

  const unique = (values: (string | null)[], fallback: string): string => {
    const labels = new Set(values);
    return labels.size === 1 ? [...labels][0] ?? fallback : labels.size ? "Mixed" : fallback;
  };
  const strategyKey = args.strategyKey ?? unique(closed.map((r) => r.agentKey), "Unattributed");
  const symbol = args.symbol ?? unique(closed.map((r) => r.symbol), "Unknown");
  const timeframe = args.timeframe ?? unique(closed.map((r) => r.timeframe), "Unknown");
  const summary = summarizeMissionTest({ kind: "FORWARD", strategyKey, symbol, timeframe, metrics, evidence: CLOSED_DRAFT_EVIDENCE });

  const result = await persistTestResult({
    userId: args.userId, missionId: args.missionId, kind: "FORWARD",
    strategyKey, symbol, timeframe, metrics, summary,
    experiment: { version: 1, engine: "closed-draft-aggregate-v1", rObservedCount: rCount, closedDraftCount: total,
      filters: { strategyKey: args.strategyKey ?? null, symbol: args.symbol ?? null, timeframe: args.timeframe ?? null },
      executionMode: "unverified", netCosts: "unverified" },
  });
  return { ok: true, result };
}

/** List a mission's test results, newest first. Caller must own the mission. */
export async function listMissionTestResults(
  userId: number,
  missionId: number,
  opts?: { limit?: number },
): Promise<MissionTestResultDto[]> {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
  const rows = await db
    .select()
    .from(missionTestResultsTable)
    .where(
      and(eq(missionTestResultsTable.missionId, missionId), eq(missionTestResultsTable.userId, userId)),
    )
    .orderBy(desc(missionTestResultsTable.createdAt), desc(missionTestResultsTable.id))
    .limit(limit);
  return rows.map(projectMissionTestResult);
}

/** Latest verified BACKTEST + FORWARD evidence only. Diagnostic runs remain in the history. */
export async function latestMissionTestResults(
  userId: number,
  missionId: number,
): Promise<{ backtest: MissionTestResultDto | null; forward: MissionTestResultDto | null }> {
  const recent = await listMissionTestResults(userId, missionId, { limit: 200 });
  return {
    backtest: recent.find((r) => r.kind === "BACKTEST" && r.isVerified) ?? null,
    forward: recent.find((r) => r.kind === "FORWARD" && r.isVerified) ?? null,
  };
}

export { labelForKind };
