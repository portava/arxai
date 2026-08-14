import { Router } from "express";
import { db } from "@workspace/db";
import { signalsTable, botSettingsTable, riskSettingsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { GetSignalsQueryParams, GetSignalsResponse, RunScanResponse, GetLatestSignalsResponse } from "@workspace/api-zod";
import { runStrategyScan, generateSyntheticCandles } from "../lib/strategyEngine";

const router = Router();

const SYMBOLS = ["Volatility 75 Index", "Volatility 75 1s Index", "Volatility 25 1s Index"];

async function scanAllSymbols(minConfidence: number) {
  const results = [];
  for (const symbol of SYMBOLS) {
    const candles = generateSyntheticCandles(symbol, 250);
    const signal = runStrategyScan(symbol, candles, minConfidence);
    const inserted = await db.insert(signalsTable).values({
      symbol: signal.symbol,
      direction: signal.direction,
      confidence: signal.confidence,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      strategy: signal.strategy,
      reason: signal.reason,
      riskWarning: signal.riskWarning,
    }).returning();
    results.push(inserted[0]);
  }
  return results;
}

// GET /signals
router.get("/signals", async (req, res) => {
  try {
    const params = GetSignalsQueryParams.parse({
      symbol: req.query["symbol"],
      limit: req.query["limit"] ? Number(req.query["limit"]) : 20,
    });
    let query = db.select().from(signalsTable).orderBy(desc(signalsTable.createdAt)).limit(params.limit ?? 20);
    const rows = await query;
    const filtered = params.symbol ? rows.filter((r) => r.symbol === params.symbol) : rows;
    const data = GetSignalsResponse.parse(filtered.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
    })));
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get signals" });
  }
});

// POST /signals/scan
router.post("/signals/scan", async (req, res) => {
  try {
    const riskRows = await db.select().from(riskSettingsTable).limit(1);
    const minConfidence = riskRows[0]?.minConfidenceScore ?? 65;

    const results = await scanAllSymbols(minConfidence);

    // Update lastScanAt
    const botRows = await db.select().from(botSettingsTable).limit(1);
    if (botRows[0]) {
      await db.update(botSettingsTable).set({ lastScanAt: new Date() }).where(eq(botSettingsTable.id, botRows[0].id));
    }

    const data = RunScanResponse.parse(results.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
    })));
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to run scan" });
  }
});

// GET /signals/latest
router.get("/signals/latest", async (req, res) => {
  try {
    const all = await db.select().from(signalsTable).orderBy(desc(signalsTable.createdAt)).limit(100);
    // Get most recent signal per symbol
    const seen = new Set<string>();
    const latest = all.filter((r) => {
      if (seen.has(r.symbol)) return false;
      seen.add(r.symbol);
      return true;
    });
    const data = GetLatestSignalsResponse.parse(latest.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
    })));
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get latest signals" });
  }
});

export { scanAllSymbols };
export default router;
