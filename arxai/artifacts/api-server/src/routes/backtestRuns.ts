// (P) Build P — Backtesting & Strategy Validation Engine routes.
//
// Composes:
//   - strategyEngine (runStrategyScan, generateSyntheticCandles, getMarketTypeForSymbol)
//   - @workspace/domain/backtest (pure simulator + metrics)
//   - vault BEHAVIOR audit on every run + AI review
//
// Routes:
//   POST /backtest-runs                 — create + execute a run
//   GET  /backtest-runs                 — list recent runs
//   GET  /backtest-runs/:id             — run by id
//   GET  /backtest-runs/:id/trades      — per-trade detail
//   POST /backtest-runs/:id/ai-review   — generate / refresh AI summary
//
// SAFETY: never mutates trades / live_positions / safetyCore. Pure
// historical simulation. AI review always closes with the spec disclaimer
// "Past performance does not guarantee future results."

import { Router } from "express";
import {
  db, backtestRunsTable, backtestTradesTable, vaultEventsTable, brokerCandlesTable,
} from "@workspace/db";
import { and, countDistinct, desc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod/v4";
import {
  simulateBacktest, computeMetrics, summarizeBacktest, isVerificationEligible,
  type BacktestCandle, type BacktestSignal,
} from "@workspace/domain/backtest";
import {
  generateDeterministicCandles, runSingleStrategy, isKnownStrategyId,
  timeframeMs, type StrategyId,
} from "../lib/backtestStrategyRegistry.js";
import type { Candle } from "../lib/strategyEngine.js";
import {
  resolveArxMarket, isApprovedArxMarket, arxFocusBlockedEnvelope, arxFocusApprovedEnvelope,
  isGoldMode, GOLD_STRATEGY_TEMPLATES, resolveGoldMacro,
} from "@workspace/domain/market";
import {
  backtestClosedCandleCount, evaluateBacktestDataReliability,
} from "../lib/backtest/backtestDataReliability.js";
import {
  buildBacktestChartSeries, type BacktestChartTradeInput,
} from "../lib/backtest/backtestChartSeries.js";

const router = Router();

async function vaultBehavior(kind: string, payload: Record<string, unknown>) {
  await db.insert(vaultEventsTable).values({
    kind, severity: "INFO", source: "SYSTEM", truthDomain: "BEHAVIOR",
    summary: kind, payload, reasons: [], blockers: [],
    generatedAtIso: new Date().toISOString(),
  }).catch(() => { /* non-fatal */ });
}

// ── PART B (Phase 2, DISPLAY ONLY) — backtest data-reliability badge ─────────
// Thin route adapter over the pure `backtest/backtestDataReliability` module.
// Computes the run's exact closed-candle count from its window (the generator
// anchors endTime = startTime + (n-1)·tfMs, so (endTime − startTime)/tfMs + 1 is
// the exact count) and composes the shared sufficiency engine on the DEPTH +
// APPROVAL axes only (freshness is N/A for settled history).
//
// SAFETY: read-only display. This NEVER blocks a run, alters metrics, or touches
// the live trade path. The verdict can only describe reliability, never grant.
function backtestDataReliability(args: {
  symbol: string; timeframe: string; startTime: Date; endTime: Date;
}) {
  const availableClosedCandles = backtestClosedCandleCount(
    timeframeMs(args.timeframe),
    args.startTime.getTime(),
    args.endTime.getTime(),
  );
  return evaluateBacktestDataReliability({
    symbol: args.symbol,
    timeframe: args.timeframe,
    availableClosedCandles,
  });
}

// Task #797 — dataSource-aware reliability for read surfaces. Broker runs have
// calendar gaps (weekends/closed sessions), so the window formula above would
// overstate their bar count; instead count the REAL distinct closed bars inside
// the run's window. Synthetic runs keep the exact window formula (the generator
// has no gaps). Display-only, never a gate.
async function resolveRunDataReliability(
  run: { symbol: string; timeframe: string; startTime: Date; endTime: Date; dataSource: string },
  canonicalSymbol: string,
) {
  if (run.dataSource === "broker") {
    const rows = await db
      .select({ n: countDistinct(brokerCandlesTable.openTimeUtc) })
      .from(brokerCandlesTable)
      .where(and(
        eq(brokerCandlesTable.symbol, canonicalSymbol),
        eq(brokerCandlesTable.timeframe, run.timeframe),
        eq(brokerCandlesTable.isClosedBar, true),
        gte(brokerCandlesTable.openTimeUtc, run.startTime),
        lte(brokerCandlesTable.openTimeUtc, run.endTime),
      ));
    return evaluateBacktestDataReliability({
      symbol: run.symbol,
      timeframe: run.timeframe,
      availableClosedCandles: Number(rows[0]?.n ?? 0),
    });
  }
  return backtestDataReliability(run);
}

// ── POST /backtest-runs ───────────────────────────────────────────────────
const ALLOWED_TIMEFRAMES = ["M1","M5","M15","H1","H4","D1"] as const;

const CreateBacktestBody = z.object({
  strategyId: z.string().min(1).max(64),
  symbol: z.string().min(1).max(64),
  timeframe: z.enum(ALLOWED_TIMEFRAMES).default("M1"),
  candleCount: z.number().int().min(50).max(5000).default(500),
  initialBalance: z.number().positive().default(10_000),
  minConfidence: z.number().int().min(0).max(100).default(60),
  // Deterministic seed. If omitted, defaults to the strategy+symbol+timeframe
  // tuple so identical configs reproduce identical results.
  seed: z.string().min(1).max(128).optional(),
  // Optional REAL-history window (Task #797). When given, the run uses
  // broker_candles bars inside [startTime, endTime] ONLY — insufficient
  // history yields an honest INSUFFICIENT_DATA run, never a synthetic
  // fallback. Both bounds must be provided together.
  startTime: z.string().min(1).max(64).optional(),
  endTime: z.string().min(1).max(64).optional(),
});

// Minimum real closed bars needed to run a meaningful simulation — matches the
// smallest candleCount the request schema accepts (strategy warm-up windows
// need depth; fewer bars would produce a misleadingly thin sample).
const MIN_BROKER_BARS = 50;

// Read REAL closed bars from the durable broker_candles store (market-data /
// telemetry only — this table never touches execution or the live pipeline).
// Multiple bridges can report the same bar, so rows are deduped on the open
// instant (first accepted row wins) and returned oldest→newest.
async function loadBrokerHistory(args: {
  symbol: string;
  timeframe: string;
  rangeStart: Date | null;
  rangeEnd: Date | null;
  maxBars: number;
}): Promise<Candle[]> {
  const conds = [
    eq(brokerCandlesTable.symbol, args.symbol),
    eq(brokerCandlesTable.timeframe, args.timeframe),
    eq(brokerCandlesTable.isClosedBar, true),
  ];
  if (args.rangeStart) conds.push(gte(brokerCandlesTable.openTimeUtc, args.rangeStart));
  if (args.rangeEnd) conds.push(lte(brokerCandlesTable.openTimeUtc, args.rangeEnd));
  const rows = await db
    .select({
      openTimeUtc: brokerCandlesTable.openTimeUtc,
      open: brokerCandlesTable.open,
      high: brokerCandlesTable.high,
      low: brokerCandlesTable.low,
      close: brokerCandlesTable.close,
      tickVolume: brokerCandlesTable.tickVolume,
    })
    .from(brokerCandlesTable)
    .where(and(...conds))
    .orderBy(desc(brokerCandlesTable.openTimeUtc))
    // Headroom for multi-bridge duplicates of the same bar (deduped below).
    .limit(args.maxBars * 3);
  const byOpen = new Map<number, (typeof rows)[number]>();
  for (const r of rows) {
    const k = r.openTimeUtc.getTime();
    if (!byOpen.has(k)) byOpen.set(k, r);
  }
  return [...byOpen.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-args.maxBars)
    .map(([, r]) => ({
      time: r.openTimeUtc.toISOString(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.tickVolume ?? 0,
    }));
}

router.post("/backtest-runs", async (req, res): Promise<void> => {
  try {
    const body = CreateBacktestBody.parse(req.body ?? {});
    if (!isKnownStrategyId(body.strategyId)) {
      res.status(400).json({
        error: "Unknown strategyId",
        allowed: ["trendContinuation","breakOfStructure","liquiditySweep","volatilityExpansion","pullbackContinuation","meanReversion","sessionBreakout"],
      });
      return;
    }
    // ARX Focus-Lock backstop (Task #570): a backtest may only be run for an
    // approved market. Unapproved symbols get the shared blocked envelope and
    // NO run is created / no candles generated. Additive — never touches an
    // existing gate or position-management path.
    const focusMarket = resolveArxMarket(body.symbol);
    if (!focusMarket) {
      res.status(200).json(arxFocusBlockedEnvelope(body.symbol));
      return;
    }

    const strategyId = body.strategyId as StrategyId;
    const seed = body.seed ?? `${strategyId}|${body.symbol}|${body.timeframe}`;

    // ── Task #797 — REAL broker history first ────────────────────────────
    // Validate the optional explicit history window (both bounds together).
    const hasRange = body.startTime !== undefined || body.endTime !== undefined;
    if (hasRange && (body.startTime === undefined || body.endTime === undefined)) {
      res.status(400).json({ error: "startTime and endTime must be provided together" });
      return;
    }
    let rangeStart: Date | null = null;
    let rangeEnd: Date | null = null;
    if (hasRange) {
      const s = Date.parse(body.startTime!);
      const e = Date.parse(body.endTime!);
      if (Number.isNaN(s) || Number.isNaN(e)) {
        res.status(400).json({ error: "startTime / endTime must be valid ISO date-times" });
        return;
      }
      if (s >= e) {
        res.status(400).json({ error: "startTime must be before endTime" });
        return;
      }
      rangeStart = new Date(s);
      rangeEnd = new Date(e);
    }

    // Real closed broker bars for the canonical symbol (the broker store keys
    // candles by the normalized ARX symbol the charts query by).
    const brokerCandles = await loadBrokerHistory({
      symbol: focusMarket.canonicalSymbol,
      timeframe: body.timeframe,
      rangeStart, rangeEnd,
      maxBars: body.candleCount,
    });

    // Data-source decision (honest, never a silent substitution):
    //   - enough real bars              → run on REAL broker history ("broker")
    //   - explicit range + not enough   → honest INSUFFICIENT_DATA run, NO
    //                                     synthetic fallback (real-or-nothing)
    //   - no range + no broker history  → clearly-labeled synthetic path
    if (hasRange && brokerCandles.length < MIN_BROKER_BARS) {
      const insufficientSummary =
        `Insufficient broker history for ${focusMarket.canonicalSymbol} ${body.timeframe} in the requested range: ` +
        `${brokerCandles.length} closed bars available, ${MIN_BROKER_BARS} required. ` +
        `No simulation was run — synthetic data is never substituted for an explicit history range.`;
      const insertedInsufficient = await db.insert(backtestRunsTable).values({
        strategyId,
        symbol: body.symbol,
        timeframe: body.timeframe,
        startTime: rangeStart!,
        endTime: rangeEnd!,
        initialBalance: body.initialBalance,
        status: "INSUFFICIENT_DATA",
        dataSource: "broker",
        aiSummary: insufficientSummary,
        isVerified: "UNVERIFIED",
      }).returning();
      const insufficientRun = insertedInsufficient[0]!;
      await vaultBehavior("BACKTEST_RUN_INSUFFICIENT_DATA", {
        runId: insufficientRun.id, strategyId, symbol: body.symbol,
        timeframe: body.timeframe, dataSource: "broker",
        availableClosedCandles: brokerCandles.length, requiredClosedCandles: MIN_BROKER_BARS,
        rangeStart: rangeStart!.toISOString(), rangeEnd: rangeEnd!.toISOString(),
      });
      res.json({
        ...insufficientRun,
        startTime: insufficientRun.startTime.toISOString(),
        endTime: insufficientRun.endTime.toISOString(),
        createdAt: insufficientRun.createdAt.toISOString(),
        equityCurve: [body.initialBalance],
        arxFocus: arxFocusApprovedEnvelope(focusMarket),
        dataReliability: evaluateBacktestDataReliability({
          symbol: body.symbol,
          timeframe: body.timeframe,
          availableClosedCandles: brokerCandles.length,
        }),
      });
      return;
    }

    const useBrokerHistory = brokerCandles.length >= MIN_BROKER_BARS;
    const dataSource: "broker" | "synthetic" = useBrokerHistory ? "broker" : "synthetic";

    // Anchor the synthetic candle stream so endTime is deterministic &
    // spec-compliant (endTime = baseTime + (count-1) * timeframeMs).
    const baseTimeMs = Date.UTC(2024, 0, 1, 0, 0, 0);
    const candles: Candle[] = useBrokerHistory
      ? brokerCandles
      : generateDeterministicCandles({
          symbol: body.symbol, count: body.candleCount,
          timeframe: body.timeframe, seed, baseTimeMs,
        });

    // Pure-domain simulation: route binds the *single* requested strategy
    // (not the multi-strategy scanner) so verification/AI summary attribution
    // is correct.
    const simInput: BacktestCandle[] = candles;
    const signalFn = (window: BacktestCandle[]): BacktestSignal => {
      const sig = runSingleStrategy(strategyId, body.symbol, window as Candle[], body.minConfidence);
      return {
        direction: sig.direction,
        entryPrice: sig.entryPrice,
        stopLoss: sig.stopLoss,
        takeProfit: sig.takeProfit,
        confidence: sig.confidence,
        strategy: sig.strategy,
      };
    };

    const sim = simulateBacktest(body.symbol, simInput, signalFn, body.initialBalance);
    const fallbackEndIso = new Date(baseTimeMs + body.candleCount * timeframeMs(body.timeframe)).toISOString();
    const startCandleTime = candles[0]?.time ?? new Date(baseTimeMs).toISOString();
    const endCandleTime   = candles[candles.length - 1]?.time ?? fallbackEndIso;

    const status = sim.metrics.totalTrades === 0
      ? "INSUFFICIENT_DATA"
      : "COMPLETED";
    const isVerified = sim.metrics.totalTrades > 0 && isVerificationEligible(sim.metrics)
      ? "VERIFIED" : "UNVERIFIED";
    const aiSummary = summarizeBacktest({
      strategyId, symbol: body.symbol,
      timeframe: body.timeframe, metrics: sim.metrics,
    });

    const inserted = await db.insert(backtestRunsTable).values({
      strategyId,
      symbol: body.symbol,
      timeframe: body.timeframe,
      startTime: new Date(startCandleTime),
      endTime: new Date(endCandleTime),
      initialBalance: body.initialBalance,
      totalTrades: sim.metrics.totalTrades,
      winningTrades: sim.metrics.winningTrades,
      losingTrades: sim.metrics.losingTrades,
      netProfitLoss: sim.metrics.netProfitLoss,
      maxDrawdown: sim.metrics.maxDrawdown,
      winRate: sim.metrics.winRate,
      averageRr: sim.metrics.averageRr,
      expectancy: sim.metrics.expectancy,
      profitFactor: sim.metrics.profitFactor,
      status, dataSource, aiSummary, isVerified,
    }).returning();
    const run = inserted[0]!;

    if (sim.trades.length > 0) {
      await db.insert(backtestTradesTable).values(sim.trades.map((t) => ({
        backtestRunId: run.id,
        symbol: t.symbol, direction: t.direction,
        entryTime: new Date(t.entryTime), exitTime: new Date(t.exitTime),
        entryPrice: t.entryPrice, exitPrice: t.exitPrice,
        stopLoss: t.stopLoss, takeProfit: t.takeProfit,
        profitLoss: t.profitLoss, rewardToRisk: t.rewardToRisk,
        result: t.result,
      })));
    }

    await vaultBehavior("BACKTEST_RUN_COMPLETED", {
      runId: run.id, strategyId, symbol: body.symbol,
      timeframe: body.timeframe, status, isVerified, dataSource,
      // The seed only shapes the synthetic generator; broker runs use real bars.
      ...(useBrokerHistory ? {} : { seed }),
      totalTrades: sim.metrics.totalTrades, profitFactor: sim.metrics.profitFactor,
      netPnl: sim.metrics.netProfitLoss,
    });

    // GOLD STRATEGY MODE (Task #657) — display-only advisory context attached for
    // gold symbols. It lists the gold strategy templates and an honest macro note
    // (no macro provider is wired into the backtest path ⇒ "unavailable"). It is
    // pure metadata: it NEVER alters the deterministic simulation, the strategy
    // executed, or the verification verdict above.
    const goldStrategyContext = isGoldMode(body.symbol)
      ? {
          active: true as const,
          macroBias: resolveGoldMacro({ newsConnected: false }).macroBias,
          macroNote:
            "Macro unavailable in backtests — gold templates are advisory context only and do not change the simulated result.",
          templates: GOLD_STRATEGY_TEMPLATES.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
          })),
        }
      : null;

    res.json({
      ...run,
      startTime: run.startTime.toISOString(),
      endTime: run.endTime.toISOString(),
      createdAt: run.createdAt.toISOString(),
      equityCurve: sim.metrics.equityCurve,
      arxFocus: arxFocusApprovedEnvelope(focusMarket),
      // Broker runs report the EXACT number of real closed bars analysed;
      // synthetic runs keep the window-derived count (exact for the generator,
      // which never has calendar gaps).
      dataReliability: useBrokerHistory
        ? evaluateBacktestDataReliability({
            symbol: body.symbol,
            timeframe: body.timeframe,
            availableClosedCandles: candles.length,
          })
        : backtestDataReliability(run),
      ...(goldStrategyContext ? { goldStrategyContext } : {}),
    });
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid backtest request", issues: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /backtest-runs failed");
    res.status(500).json({ error: "Failed to run backtest" });
  }
});

// ── GET /backtest-runs ────────────────────────────────────────────────────
router.get("/backtest-runs", async (req, res): Promise<void> => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query["limit"]) || 50));
    const allRows = await db.select().from(backtestRunsTable)
      .orderBy(desc(backtestRunsTable.createdAt)).limit(limit);
    // Hide saved runs whose symbol is no longer in the approved universe. The
    // rows stay in the DB (never deleted) — they are simply not surfaced in the
    // active UI, consistent with the Focus-Lock "hidden not deleted" rule.
    const rows = allRows.filter((r) => isApprovedArxMarket(r.symbol));
    res.json({ runs: rows.map((r) => {
      const focusMarket = resolveArxMarket(r.symbol);
      return {
        ...r,
        startTime: r.startTime.toISOString(),
        endTime: r.endTime.toISOString(),
        createdAt: r.createdAt.toISOString(),
        ...(focusMarket ? { arxFocus: arxFocusApprovedEnvelope(focusMarket) } : {}),
      };
    }) });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /backtest-runs failed");
    res.status(500).json({ error: "Failed to load runs" });
  }
});

// ── GET /backtest-runs/:id ────────────────────────────────────────────────
router.get("/backtest-runs/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const rows = await db.select().from(backtestRunsTable).where(eq(backtestRunsTable.id, id)).limit(1);
    if (!rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    const r = rows[0];
    // Focus-Lock (Task #570): a run on a now-unapproved symbol is hidden from
    // the active UI — return the shared blocked envelope, never the run data.
    // The DB row is preserved (never deleted).
    const focusMarket = resolveArxMarket(r.symbol);
    if (!focusMarket) {
      res.status(200).json(arxFocusBlockedEnvelope(r.symbol));
      return;
    }
    res.json({
      ...r,
      startTime: r.startTime.toISOString(),
      endTime: r.endTime.toISOString(),
      createdAt: r.createdAt.toISOString(),
      arxFocus: arxFocusApprovedEnvelope(focusMarket),
      dataReliability: await resolveRunDataReliability(r, focusMarket.canonicalSymbol),
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /backtest-runs/:id failed");
    res.status(500).json({ error: "Failed to load run" });
  }
});

// ── GET /backtest-runs/:id/trades ─────────────────────────────────────────
router.get("/backtest-runs/:id/trades", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    // Focus-Lock (Task #570): never surface trades for a run whose symbol is
    // outside the approved universe — return the shared blocked envelope. Rows
    // stay in the DB.
    const parentRun = await db.select().from(backtestRunsTable).where(eq(backtestRunsTable.id, id)).limit(1);
    if (parentRun[0] && !isApprovedArxMarket(parentRun[0].symbol)) {
      res.status(200).json(arxFocusBlockedEnvelope(parentRun[0].symbol));
      return;
    }
    const rows = await db.select().from(backtestTradesTable)
      .where(eq(backtestTradesTable.backtestRunId, id))
      .orderBy(backtestTradesTable.entryTime);
    res.json({ trades: rows.map((t) => ({
      ...t,
      entryTime: t.entryTime.toISOString(),
      exitTime: t.exitTime.toISOString(),
      createdAt: t.createdAt.toISOString(),
    })) });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /backtest-runs/:id/trades failed");
    res.status(500).json({ error: "Failed to load trades" });
  }
});

// ── GET /backtest-runs/:id/chart-series ───────────────────────────────────
// DISPLAY-ONLY equity-curve + drawdown + trade-marker series for the Testing
// Lab. Derived from the run's stored initialBalance + per-trade profitLoss —
// no new source of truth, no execution path. Focus-Lock applies: a run on a
// now-unapproved symbol returns the shared blocked envelope, never the series.
router.get("/backtest-runs/:id/chart-series", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const runs = await db.select().from(backtestRunsTable).where(eq(backtestRunsTable.id, id)).limit(1);
    const run = runs[0];
    if (!run) { res.status(404).json({ error: "Not found" }); return; }
    const focusMarket = resolveArxMarket(run.symbol);
    if (!focusMarket) {
      res.status(200).json(arxFocusBlockedEnvelope(run.symbol));
      return;
    }
    const tradeRows = await db.select().from(backtestTradesTable)
      .where(eq(backtestTradesTable.backtestRunId, id))
      .orderBy(backtestTradesTable.entryTime);
    const trades: BacktestChartTradeInput[] = tradeRows.map((t) => ({
      direction: t.direction as "BUY" | "SELL",
      entryTime: t.entryTime.toISOString(),
      exitTime: t.exitTime.toISOString(),
      entryPrice: t.entryPrice, exitPrice: t.exitPrice,
      stopLoss: t.stopLoss, takeProfit: t.takeProfit,
      profitLoss: t.profitLoss, rewardToRisk: t.rewardToRisk,
      result: t.result,
    }));
    const series = buildBacktestChartSeries({ initialBalance: run.initialBalance, trades });
    res.json({
      ...series,
      runId: run.id,
      strategyId: run.strategyId,
      symbol: run.symbol,
      timeframe: run.timeframe,
      arxFocus: arxFocusApprovedEnvelope(focusMarket),
      dataReliability: await resolveRunDataReliability(run, focusMarket.canonicalSymbol),
    });
  } catch (err) {
    req.log.error({ err: String(err) }, "GET /backtest-runs/:id/chart-series failed");
    res.status(500).json({ error: "Failed to load chart series" });
  }
});

// ── POST /backtest-runs/:id/ai-review ─────────────────────────────────────
router.post("/backtest-runs/:id/ai-review", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const runs = await db.select().from(backtestRunsTable).where(eq(backtestRunsTable.id, id)).limit(1);
    const run = runs[0];
    if (!run) { res.status(404).json({ error: "Not found" }); return; }
    // Focus-Lock (Task #570): never run an AI review on a now-unapproved symbol;
    // return the shared blocked envelope. The run row is preserved.
    if (!isApprovedArxMarket(run.symbol)) {
      res.status(200).json(arxFocusBlockedEnvelope(run.symbol));
      return;
    }
    const trades = await db.select().from(backtestTradesTable)
      .where(eq(backtestTradesTable.backtestRunId, id))
      .orderBy(backtestTradesTable.entryTime);

    // Recompute equity curve so we can re-summarize without storing it.
    const equity = [run.initialBalance];
    let eq2 = run.initialBalance;
    for (const t of trades) { eq2 += t.profitLoss; equity.push(eq2); }
    const metrics = computeMetrics(
      trades.map((t) => ({
        symbol: t.symbol, direction: t.direction as "BUY" | "SELL",
        entryTime: t.entryTime.toISOString(), exitTime: t.exitTime.toISOString(),
        entryPrice: t.entryPrice, exitPrice: t.exitPrice,
        stopLoss: t.stopLoss, takeProfit: t.takeProfit,
        profitLoss: t.profitLoss, rewardToRisk: t.rewardToRisk,
        result: t.result as "WIN" | "LOSS" | "BREAKEVEN" | "TIMEOUT",
      })),
      run.initialBalance, equity,
    );
    const aiSummary = summarizeBacktest({
      strategyId: run.strategyId, symbol: run.symbol,
      timeframe: run.timeframe, metrics,
    });

    await db.update(backtestRunsTable).set({ aiSummary }).where(eq(backtestRunsTable.id, id));
    await vaultBehavior("BACKTEST_AI_REVIEW_GENERATED", { runId: id });
    res.json({ id, aiSummary, metrics });
  } catch (err) {
    req.log.error({ err: String(err) }, "POST /backtest-runs/:id/ai-review failed");
    res.status(500).json({ error: "Failed to generate AI review" });
  }
});

// Export latest VERIFIED run summary per strategy for the strategy-fit
// scoring engine to consume (read-only). Future build can pull from this.
export async function getLatestVerifiedRunForStrategy(strategyId: string): Promise<typeof backtestRunsTable.$inferSelect | null> {
  const rows = await db.select().from(backtestRunsTable)
    .where(eq(backtestRunsTable.strategyId, strategyId))
    .orderBy(desc(backtestRunsTable.createdAt)).limit(20);
  return rows.find((r) => r.isVerified === "VERIFIED") ?? null;
}

export default router;
