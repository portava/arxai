// Build JJ — Strategy Lab routes. REPLAY_ONLY.
import { Router } from "express";
import { buildSyntheticScenario, persistScenario } from "../lib/replaySim/scenarios.js";
import { createExperiment, listExperiments, getExperiment, runExperiment, compareExperiments } from "../lib/replaySim/strategyLab.js";

const router = Router();
const TAG = "Build JJ — Strategy Lab. REPLAY_ONLY experiments. Never places trades, never calls MT5, never enables canPlaceTrades, never recommends live trading.";

function envelope(body: Record<string, unknown>) {
  return {
    system: "strategyLab",
    liveTradingStatus: "DISABLED" as const,
    mode: "REPLAY_ONLY" as const,
    disclaimer: TAG,
    ...body,
  };
}

router.post("/strategy-lab/demo", async (_req, res) => {
  try {
    const conditions: Array<"TRENDING_UP" | "TRENDING_DOWN" | "RANGING"> = ["TRENDING_UP", "TRENDING_DOWN", "RANGING"];
    const scenarioIds: string[] = [];
    for (const c of conditions) {
      const s = buildSyntheticScenario({ marketCondition: c, candleCount: 80, seed: 100 + conditions.indexOf(c), title: `Lab Demo ${c} V75` });
      await persistScenario(s);
      scenarioIds.push(s.scenarioId);
    }
    const expId = await createExperiment({
      title: "Demo Strategy Lab — 3 conditions",
      symbol: "V75", timeframe: "M5",
      playbookEntryId: "",
      scenarioIds,
      settings: { minConfidence: 55, maxRiskScore: 70, minSniperEntryScore: 30, useSniperFilter: true, slDistance: 5, tpDistance: 10 },
    });
    const result = await runExperiment(expId);
    res.json(envelope({ demo: true, experiment_id: expId, scenario_ids: scenarioIds, result }));
  } catch (err) {
    res.status(500).json(envelope({ error: "lab demo failed", detail: String(err).slice(0, 200) }));
  }
});

router.post("/strategy-lab/experiments", async (req, res) => {
  try {
    const body = req.body ?? {};
    const scenarioIds: string[] = Array.isArray(body.scenario_ids ?? body.scenarioIds) ? (body.scenario_ids ?? body.scenarioIds) : [];
    if (scenarioIds.length === 0) { res.status(400).json(envelope({ error: "scenario_ids required" })); return; }
    const expId = await createExperiment({
      title: String(body.title ?? "Experiment"),
      symbol: body.symbol, timeframe: body.timeframe,
      playbookEntryId: body.playbook_entry_id ?? body.playbookEntryId,
      scenarioIds,
      settings: body.settings ?? {},
    });
    res.json(envelope({ experiment_id: expId }));
  } catch (err) {
    res.status(500).json(envelope({ error: "create experiment failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/strategy-lab/experiments", async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 200);
    const rows = await listExperiments(limit);
    res.json(envelope({ experiments: rows, count: rows.length }));
  } catch (err) {
    res.status(500).json(envelope({ error: "list experiments failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/strategy-lab/experiments/:id", async (req, res) => {
  try {
    const e = await getExperiment(req.params.id);
    if (!e) { res.status(404).json(envelope({ error: "experiment not found" })); return; }
    res.json(envelope({ experiment: e }));
  } catch (err) {
    res.status(500).json(envelope({ error: "get experiment failed", detail: String(err).slice(0, 200) }));
  }
});

router.post("/strategy-lab/experiments/:id/run", async (req, res) => {
  try {
    const result = await runExperiment(req.params.id);
    res.json(envelope({ experiment_id: req.params.id, result }));
  } catch (err) {
    res.status(500).json(envelope({ error: "run experiment failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/strategy-lab/compare", async (req, res) => {
  try {
    const idsRaw = req.query.ids;
    const ids = Array.isArray(idsRaw) ? idsRaw.map(String) : typeof idsRaw === "string" ? idsRaw.split(",") : [];
    if (ids.length === 0) { res.status(400).json(envelope({ error: "ids query parameter required (comma separated)" })); return; }
    const result = await compareExperiments(ids);
    res.json(envelope({ comparison: result, count: result.length }));
  } catch (err) {
    res.status(500).json(envelope({ error: "compare failed", detail: String(err).slice(0, 200) }));
  }
});

export default router;
