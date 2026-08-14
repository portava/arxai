// Build KK — Data Import routes (DATA_IMPORT mode only).

import { Router } from "express";
import {
  runImport, listImports, getImport, getImportCandles, listImportLogs,
  createReplayScenarioFromImport, buildDemoCandles, readImportedFallback,
} from "../lib/dataImport/service.js";

const router = Router();
const TAG = "Build KK — Data Import. DATA_IMPORT_ONLY. Never places trades, never calls MT5, never enables canPlaceTrades, never recommends live trading.";

function envelope(body: Record<string, unknown>) {
  return {
    system: "dataImport",
    liveTradingStatus: "DISABLED" as const,
    mode: "DATA_IMPORT" as const,
    disclaimer: TAG,
    ...body,
  };
}

router.post("/data-import/demo", async (_req, res) => {
  try {
    const candles = buildDemoCandles(60, 7);
    const r = await runImport({ symbol: "V75", timeframe: "M5", source: "DEMO", candles });
    res.json(envelope({ demo: true, import_id: r.importId, status: r.status, dataQuality: r.dataQuality, candlesValid: r.candlesValid, candlesRejected: r.candlesRejected, dataLabel: "DEMO" }));
  } catch (err) {
    res.status(500).json(envelope({ error: "demo failed", detail: String(err).slice(0, 200) }));
  }
});

router.post("/data-import/validate", async (req, res) => {
  try {
    const b = req.body ?? {};
    if (!b.symbol || !b.timeframe || !Array.isArray(b.candles)) {
      res.status(400).json(envelope({ error: "symbol, timeframe and candles[] required" })); return;
    }
    const r = await runImport({ symbol: String(b.symbol), timeframe: String(b.timeframe), source: (b.source ?? "JSON") as "JSON" | "CSV" | "MANUAL" | "DEMO", candles: b.candles, validateOnly: true });
    res.json(envelope({ import_id: r.importId, status: r.status, candlesReceived: r.candlesReceived, candlesValid: r.candlesValid, candlesRejected: r.candlesRejected, dataQuality: r.dataQuality, validatedOnly: true }));
  } catch (err) {
    res.status(500).json(envelope({ error: "validate failed", detail: String(err).slice(0, 200) }));
  }
});

router.post("/data-import/candles", async (req, res) => {
  try {
    const b = req.body ?? {};
    if (!b.symbol || !b.timeframe || !Array.isArray(b.candles)) {
      res.status(400).json(envelope({ error: "symbol, timeframe and candles[] required" })); return;
    }
    const source = (b.source ?? "JSON") as "JSON" | "CSV" | "MANUAL" | "DEMO";
    const r = await runImport({ symbol: String(b.symbol), timeframe: String(b.timeframe), source, candles: b.candles });
    const code = r.status === "REJECTED" ? 400 : 200;
    res.status(code).json(envelope({
      import_id: r.importId, status: r.status, source: r.source, symbol: r.symbol, timeframe: r.timeframe,
      candles_received: r.candlesReceived, candles_valid: r.candlesValid, candles_rejected: r.candlesRejected,
      start_time: r.startTime, end_time: r.endTime, dataQuality: r.dataQuality,
      created_at: r.createdAt, dataLabel: "IMPORTED",
    }));
  } catch (err) {
    res.status(500).json(envelope({ error: "import failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/data-import/imports", async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);
    const rows = await listImports(limit);
    res.json(envelope({
      count: rows.length,
      imports: rows.map(r => ({
        importId: r.importId, symbol: r.symbol, timeframe: r.timeframe, source: r.source, status: r.status,
        candlesReceived: r.candlesReceived, candlesValid: r.candlesValid, candlesRejected: r.candlesRejected,
        startTime: r.startTime, endTime: r.endTime, dataQuality: r.dataQuality,
        canUseForReplay: (r.status === "IMPORTED" || r.status === "PARTIAL") && r.candlesValid >= 5,
        canUseAsDDFallback: r.status === "IMPORTED" && (r.dataQuality as { status?: string })?.status !== "REJECTED",
        createdAt: r.createdAt,
      })),
    }));
  } catch (err) {
    res.status(500).json(envelope({ error: "list failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/data-import/imports/:id", async (req, res) => {
  try {
    const row = await getImport(req.params.id);
    if (!row) { res.status(404).json(envelope({ error: "import not found" })); return; }
    res.json(envelope({ import: row }));
  } catch (err) {
    res.status(500).json(envelope({ error: "get failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/data-import/imports/:id/candles", async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "200"), 10) || 200, 1000);
    const rows = await getImportCandles(req.params.id, limit);
    res.json(envelope({ count: rows.length, candles: rows, dataLabel: "IMPORTED" }));
  } catch (err) {
    res.status(500).json(envelope({ error: "candles failed", detail: String(err).slice(0, 200) }));
  }
});

router.post("/data-import/imports/:id/create-replay-scenario", async (req, res) => {
  try {
    const r = await createReplayScenarioFromImport(req.params.id, { title: req.body?.title });
    if (!r.ok) { res.status(400).json(envelope({ error: r.error })); return; }
    res.json(envelope({ scenario_id: r.scenarioId, candles: r.candles, source: "IMPORTED",
      dataLabel: "IMPORTED", note: "Scenario created in REPLAY_ONLY system. No paper or live trades created." }));
  } catch (err) {
    res.status(500).json(envelope({ error: "create-scenario failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/data-import/dd-fallback", async (req, res) => {
  try {
    const symbol = String(req.query.symbol ?? "V75");
    const timeframe = String(req.query.timeframe ?? "M5");
    const limit = Math.min(parseInt(String(req.query.limit ?? "200"), 10) || 200, 1000);
    const rows = await readImportedFallback(symbol, timeframe, limit);
    res.json(envelope({ symbol, timeframe, count: rows.length, candles: rows, dataLabel: "IMPORTED",
      warning: "Imported candles are HISTORICAL FALLBACK only. They are NEVER live market quotes." }));
  } catch (err) {
    res.status(500).json(envelope({ error: "dd-fallback failed", detail: String(err).slice(0, 200) }));
  }
});

router.get("/data-import/logs", async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 500);
    const rows = await listImportLogs(limit);
    res.json(envelope({ count: rows.length, logs: rows }));
  } catch (err) {
    res.status(500).json(envelope({ error: "logs failed", detail: String(err).slice(0, 200) }));
  }
});

export default router;
