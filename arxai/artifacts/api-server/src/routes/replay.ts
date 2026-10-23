// Build JJ — Replay Simulator routes. REPLAY_ONLY.
//
// SAFETY: All endpoints are simulation only. NEVER place trades, NEVER call
// MT5, NEVER modify canPlaceTrades. liveTradingStatus is hardcoded
// "DISABLED" and mode is hardcoded "REPLAY_ONLY" in every response envelope.

import { Router } from "express";
import { db, replayRunsTable, replayLogsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { buildSyntheticScenario, persistScenario, listScenarios, getScenario, validateCandles, type MarketCondition } from "../lib/replaySim/scenarios.js";
import { runReplay, generateReplayReport, getRun, getRunTrades, getRunReport, requestStop, listActiveRuns } from "../lib/replaySim/engine.js";
import { randomUUID } from "node:crypto";

const router = Router();
const TAG = "Build JJ — Replay Simulator + Strategy Lab. REPLAY_ONLY simulation. Never places trades, never calls MT5, never enables canPlaceTrades, never recommends live trading.";

function envelope(body: Record<string, unknown>) {
  return {
    system: "replaySimulator",
    liveTradingStatus: "DISABLED" as const,
    mode: "REPLAY_ONLY" as const,
    disclaimer: TAG,
    ...body,
  };
}

router.post("/replay/demo", async (_req, res) => {
  try {
    const scenario = buildSyntheticScenario({ marketCondition: "TRENDING_UP", candleCount: 80, seed: 1234, title: "Demo TRENDING_UP V75" });
    await persistScenario(scenario);
    const run = await runReplay(scenario, { minConfidence: 55, useSniperFilter: true });
    const report = await generateReplayReport(run, scenario);
    res.json(envelope({ demo: true, scenario_id: scenario.scenarioId, replay_run_id: run.replayRunId, report }));
  } catch (err) {
    res.status(500).json(envelope({ error: "demo failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/replay/scenarios", async (_req, res) => {
  try {
    const items = await listScenarios(50);
    res.json(envelope({ scenarios: items, count: items.length }));
  } catch (err) {
    res.status(500).json(envelope({ error: "list scenarios failed", detail: String(err).slice(0, 200) }));
  }
});

router.post("/replay/scenarios", async (req, res) => {
  try {
    const body = req.body ?? {};
    let scenario;
    if (Array.isArray(body.candles)) {
      const v = validateCandles(body.candles);
      if (!v.valid) { res.status(400).json(envelope({ error: "invalid candles", reason: v.reason })); return; }
      scenario = {
        scenarioId: `scn_imp_${Date.now()}`,
        title: String(body.title ?? "Imported scenario"),
        symbol: String(body.symbol ?? "V75"),
        timeframe: String(body.timeframe ?? "M5"),
        source: "IMPORTED" as const,
        marketCondition: (body.marketCondition ?? "RANGING") as MarketCondition,
        candles: v.candles!,
        notes: String(body.notes ?? "User-imported candles."),
      };
    } else {
      scenario = buildSyntheticScenario({
        marketCondition: body.marketCondition,
        candleCount: body.candleCount,
        symbol: body.symbol,
        timeframe: body.timeframe,
        basePrice: body.basePrice,
        seed: body.seed,
        title: body.title,
      });
    }
    await persistScenario(scenario);
    res.json(envelope({ scenario_id: scenario.scenarioId, scenario }));
  } catch (err) {
    res.status(500).json(envelope({ error: "create scenario failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/replay/scenarios/:id", async (req, res) => {
  try {
    const s = await getScenario(req.params.id);
    if (!s) { res.status(404).json(envelope({ error: "scenario not found" })); return; }
    res.json(envelope({ scenario: s }));
  } catch (err) {
    res.status(500).json(envelope({ error: "get scenario failed", detail: String(err).slice(0, 200) }));
  }
});

router.post("/replay/run", async (req, res) => {
  try {
    const body = req.body ?? {};
    const scenarioId = String(body.scenario_id ?? body.scenarioId ?? "");
    if (!scenarioId) { res.status(400).json(envelope({ error: "scenario_id required" })); return; }
    const scenario = await getScenario(scenarioId);
    if (!scenario) { res.status(404).json(envelope({ error: "scenario not found" })); return; }
    if (!scenario.candles || scenario.candles.length === 0) {
      res.status(400).json(envelope({ error: "scenario has no candles" })); return;
    }
    // Async mode: return run id immediately so the caller can stop mid-run.
    if (body.async === true) {
      const replayRunId = `rrun_${randomUUID()}`;
      // Fire-and-forget; runReplay persists results when finished.
      void runReplay(scenario, body.settings ?? {}, replayRunId)
        .then(run => generateReplayReport(run, scenario))
        .catch(() => { /* persisted via run record + logs */ });
      res.json(envelope({ async: true, replay_run_id: replayRunId, scenario_id: scenario.scenarioId, status: "STARTED" }));
      return;
    }
    const run = await runReplay(scenario, body.settings ?? {});
    const report = await generateReplayReport(run, scenario);
    res.json(envelope({
      replay_run_id: run.replayRunId,
      scenario_id: scenario.scenarioId,
      mode: "REPLAY_ONLY",
      status: run.status,
      symbol: run.symbol, timeframe: run.timeframe,
      started_at: run.startedAt, finished_at: run.finishedAt,
      candles_processed: run.candlesProcessed,
      decisions_created: run.decisionsCreated,
      simulated_trades_opened: run.trades.length,
      simulated_trades_closed: run.trades.filter(t => t.status === "CLOSED").length,
      wins: run.wins, losses: run.losses, break_even: run.breakEven,
      net_pnl: run.netPnl, max_drawdown: run.maxDrawdown,
      win_rate: run.winRate, profit_factor: run.profitFactor,
      best_trade: run.bestTrade, worst_trade: run.worstTrade,
      replay_summary: { setting_keys: Object.keys(body.settings ?? {}) },
      warnings: run.warnings, errors: run.errors,
      report,
    }));
  } catch (err) {
    res.status(500).json(envelope({ error: "replay run failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/replay/runs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 200);
    const rows = await db.select().from(replayRunsTable).orderBy(desc(replayRunsTable.createdAt)).limit(limit);
    res.json(envelope({ runs: rows, count: rows.length }));
  } catch (err) {
    res.status(500).json(envelope({ error: "list runs failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/replay/runs/:id", async (req, res) => {
  try {
    const r = await getRun(req.params.id);
    if (!r) { res.status(404).json(envelope({ error: "run not found" })); return; }
    res.json(envelope({ run: r }));
  } catch (err) {
    res.status(500).json(envelope({ error: "get run failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/replay/runs/:id/trades", async (req, res) => {
  try {
    const trades = await getRunTrades(req.params.id);
    res.json(envelope({ replay_run_id: req.params.id, trades, count: trades.length }));
  } catch (err) {
    res.status(500).json(envelope({ error: "get trades failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/replay/runs/:id/report", async (req, res) => {
  try {
    const r = await getRunReport(req.params.id);
    if (!r) { res.status(404).json(envelope({ error: "report not found" })); return; }
    res.json(envelope({ report: r }));
  } catch (err) {
    res.status(500).json(envelope({ error: "get report failed", detail: String(err).slice(0, 200) }));
  }
});

router.post("/replay/stop/:id", async (req, res) => {
  try {
    requestStop(req.params.id);
    const active = listActiveRuns().some(r => r.replayRunId === req.params.id);
    res.json(envelope({ stop_requested: req.params.id, was_active: active, active_runs: listActiveRuns() }));
  } catch (err) {
    res.status(500).json(envelope({ error: "stop failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/replay/active", async (_req, res) => {
  res.json(envelope({ active_runs: listActiveRuns() }));
});

router.get("/replay/logs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 500);
    const runId = req.query.run_id ? String(req.query.run_id) : null;
    const q = db.select().from(replayLogsTable).orderBy(desc(replayLogsTable.createdAt)).limit(limit);
    const rows = runId ? await db.select().from(replayLogsTable).where(eq(replayLogsTable.replayRunId, runId)).orderBy(desc(replayLogsTable.createdAt)).limit(limit) : await q;
    res.json(envelope({ logs: rows, count: rows.length }));
  } catch (err) {
    res.status(500).json(envelope({ error: "list logs failed", detail: String(err).slice(0, 200) }));
  }
});

export default router;
