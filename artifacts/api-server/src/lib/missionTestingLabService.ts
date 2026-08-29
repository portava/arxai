// ── Profit Mission Phase 9 — Testing Lab service (backtest + forward) ─────────
//
// SAFETY / SCOPE:
//   - COMPOSES the existing backtest engine (@workspace/domain/backtest +
//     backtestStrategyRegistry) and the pure Phase 9 testing-lab module to give a
//     mission an HONEST, labelled performance record. A BACKTEST result is
//     historical/simulated; a FORWARD result is aggregated from the mission's OWN
//     real executed-and-closed drafts (never fabricated). Results are persisted
//     append-only into `mission_test_results`.
//   - ADVISORY ONLY. Nothing here places a trade, touches the EA/broker, alters a
//     position, or relaxes/bypasses any live execution gate. A passing test can
//     never grant live permission — it is one input to the promotion gate.
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
  evidenceBasisFor,
  describeEvidenceBasis,
  type PromotionEvidenceBasis,
  type MissionTestKind,
  type MissionTestMetrics,
  type MissionTestSummary,
} from "@workspace/domain/profit-mission";
import {
  simulateBacktest,
  type BacktestCandle,
  type BacktestSignal,
  type BacktestSimTrade,
  type BacktestRunMetrics,
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
  /** What the underlying trades were — SIMULATED, BROKER_RECONCILED, or MIXED. */
  evidenceBasis: PromotionEvidenceBasis;
  createdAt: string;
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

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round((Number.isFinite(n) ? n : 0) * f) / f;
}

// Signed realised R for a simulated trade: a WIN banks the planned reward-to-risk,
// a LOSS is a full -1R stop, breakeven/timeout contribute 0R. This yields a true
// expectancy in R (vs `averageRr`, which is the mean PLANNED reward-to-risk).
function realisedR(t: BacktestSimTrade): number {
  if (t.result === "WIN") return Number.isFinite(t.rewardToRisk) ? t.rewardToRisk : 0;
  if (t.result === "LOSS") return -1;
  return 0;
}

function backtestToMissionMetrics(
  m: BacktestRunMetrics,
  trades: BacktestSimTrade[],
  initialBalance: number,
): MissionTestMetrics {
  const expectancyR = trades.length > 0
    ? trades.reduce((s, t) => s + realisedR(t), 0) / trades.length
    : 0;
  const maxDrawdownPct = initialBalance > 0 ? (m.maxDrawdown / initialBalance) * 100 : 0;
  return {
    totalTrades: m.totalTrades,
    winningTrades: m.winningTrades,
    losingTrades: m.losingTrades,
    winRate: round(m.winRate),
    netProfitLoss: round(m.netProfitLoss, 2),
    maxDrawdownPct: round(Math.max(0, maxDrawdownPct), 2),
    averageRr: round(m.averageRr),
    expectancyR: round(expectancyR),
    profitFactor: round(clampFinite(m.profitFactor), 3),
  };
}

async function loadOwnedMission(userId: number, missionId: number): Promise<MissionRow | null> {
  const rows = await db
    .select()
    .from(profitMissionsTable)
    .where(and(eq(profitMissionsTable.id, missionId), eq(profitMissionsTable.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

function projectResult(row: typeof missionTestResultsTable.$inferSelect): MissionTestResultDto {
  const blob = (row.metricsJson as Record<string, unknown> | null) ?? {};
  const metrics = (blob.metrics as MissionTestMetrics | undefined) ?? {
    totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, netProfitLoss: 0,
    maxDrawdownPct: 0, averageRr: 0, expectancyR: 0, profitFactor: 0,
  };
  return {
    id: row.id,
    missionId: row.missionId,
    kind: row.kind as MissionTestKind,
    strategyKey: row.strategyKey,
    symbol: row.symbol,
    timeframe: row.timeframe,
    label: row.label,
    sampleSize: row.sampleSize,
    sampleWarning: row.sampleWarning ?? null,
    isVerified: row.isVerified,
    metrics,
    headline: typeof blob.headline === "string" ? blob.headline : "",
    notes: Array.isArray(blob.notes) ? (blob.notes as string[]) : [],
    promotionEligible: blob.promotionEligible === true,
    // An older row with no recorded basis reads UNSTATED — never assumed proven.
    evidenceBasis: isEvidenceBasis(blob.evidenceBasis) ? blob.evidenceBasis : "UNSTATED",
    createdAt: row.createdAt.toISOString(),
  };
}

const EVIDENCE_BASES: ReadonlySet<string> = new Set([
  "NONE", "SIMULATED", "BROKER_RECONCILED", "MIXED", "UNSTATED",
]);
function isEvidenceBasis(v: unknown): v is PromotionEvidenceBasis {
  return typeof v === "string" && EVIDENCE_BASES.has(v);
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
  /** What the underlying closed trades were. Persisted so a record earned on
   *  modelled paper/demo fills is never read as broker-proven performance. */
  evidenceBasis?: PromotionEvidenceBasis;
}): Promise<MissionTestResultDto> {
  const evidenceBasis: PromotionEvidenceBasis =
    args.evidenceBasis ?? (args.kind === "BACKTEST" ? "SIMULATED" : "UNSTATED");
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
        notes: [...args.summary.notes, describeEvidenceBasis(evidenceBasis)],
        promotionEligible: args.summary.promotionEligible,
        evidenceBasis,
      },
      isVerified: args.summary.promotionEligible,
    })
    .returning();
  return projectResult(inserted[0]!);
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
 * Run a deterministic historical/simulated backtest for the mission's strategy and
 * persist an honest, labelled BACKTEST result. Focus-Lock + per-user scoped. The
 * result is advisory input to the promotion gate — never a live grant.
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
    timeframe: args.timeframe, metrics,
  });

  // Anchor timeframe so the backtest window stays deterministic for the seed.
  void timeframeMs(args.timeframe);

  const result = await persistTestResult({
    userId: args.userId, missionId: args.missionId, kind: "BACKTEST",
    strategyKey: strategyId, symbol: args.symbol, timeframe: args.timeframe, metrics, summary,
  });
  return { ok: true, result };
}

export interface AggregateForwardArgs {
  userId: number;
  missionId: number;
  /** Strategy/agent label to attribute the forward record to (display only). */
  strategyKey?: string;
  symbol?: string;
  timeframe?: string;
}

/**
 * Aggregate a FORWARD result from the mission's OWN executed-and-closed drafts.
 * Never fabricates a forward record: with zero closed trades it still writes an
 * honest empty result with a small-sample warning, and a small sample is flagged
 * so the promotion gate will not count it as satisfied.
 *
 * TWO KINDS OF FORWARD EVIDENCE, both real, never blended into one money figure:
 *   - broker-reconciled closes (`pnl` + `closedAt`) from a LIVE mission, and
 *   - SIMULATED closes (`sim_pnl` + `sim_closed_at`) from a paper/demo mission,
 *     modelled from real quotes by the fill simulator.
 * A paper/demo mission produces only the second kind — which is exactly what
 * "forward (paper / demo / live)" has always meant. The persisted result records
 * the basis so a forward record earned on modelled fills can never be read as
 * broker-proven performance.
 */
export async function aggregateMissionForward(args: AggregateForwardArgs): Promise<TestingLabResult> {
  const mission = await loadOwnedMission(args.userId, args.missionId);
  if (!mission) return { ok: false, kind: "not_found" };

  const rows = await db
    .select({
      pnl: missionTradeDraftsTable.pnl,
      simPnl: missionTradeDraftsTable.simPnl,
      rMultiple: missionTradeDraftsTable.rMultiple,
      simRMultiple: missionTradeDraftsTable.simRMultiple,
      closedAt: missionTradeDraftsTable.closedAt,
      simClosedAt: missionTradeDraftsTable.simClosedAt,
      simulated: missionTradeDraftsTable.simulated,
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

  // Normalize each row onto ONE of the two families — never both. A simulated
  // row reads its `sim_*` columns; a broker row reads its reconciled columns.
  const closed = rows
    .map((r) => {
      const useSim = r.simulated === true;
      const pnl = useSim ? r.simPnl : r.pnl;
      const closedAt = useSim ? r.simClosedAt : r.closedAt;
      const rMultiple = useSim ? r.simRMultiple : r.rMultiple;
      return { ...r, pnl, closedAt, rMultiple, isSimulated: useSim };
    })
    .filter((r) => r.closedAt != null && r.pnl != null && Number.isFinite(r.pnl))
    .sort((a, b) => (a.closedAt as Date).getTime() - (b.closedAt as Date).getTime());
  const forwardEvidenceBasis = evidenceBasisFor({
    simulatedCount: closed.filter((r) => r.isSimulated).length,
    brokerReconciledCount: closed.filter((r) => !r.isSimulated).length,
  });
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
  let maxDrawdown = 0;
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
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  const total = closed.length;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
  const maxDrawdownPct = peak > 0 ? (maxDrawdown / peak) * 100 : 0;

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

  const strategyKey = args.strategyKey ?? closed[0]?.agentKey ?? "mission";
  const symbol = args.symbol ?? closed[0]?.symbol ?? "—";
  const timeframe = args.timeframe ?? closed[0]?.timeframe ?? "—";
  const summary = summarizeMissionTest({ kind: "FORWARD", strategyKey, symbol, timeframe, metrics });

  const result = await persistTestResult({
    userId: args.userId, missionId: args.missionId, kind: "FORWARD",
    strategyKey, symbol, timeframe, metrics, summary,
    evidenceBasis: forwardEvidenceBasis,
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
  return rows.map(projectResult);
}

/** Latest BACKTEST + FORWARD result (for drift / promotion composition). */
export async function latestMissionTestResults(
  userId: number,
  missionId: number,
): Promise<{ backtest: MissionTestResultDto | null; forward: MissionTestResultDto | null }> {
  const recent = await listMissionTestResults(userId, missionId, { limit: 200 });
  return {
    backtest: recent.find((r) => r.kind === "BACKTEST") ?? null,
    forward: recent.find((r) => r.kind === "FORWARD") ?? null,
  };
}

export { labelForKind };
