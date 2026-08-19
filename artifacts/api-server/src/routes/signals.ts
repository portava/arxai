import { Router } from "express";
import { db } from "@workspace/db";
import { signalsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { GetSignalsQueryParams, GetSignalsResponse, GetLatestSignalsResponse } from "@workspace/api-zod";

const router = Router();

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
// The old scan built candles with generateSyntheticCandles (a Math.random walk
// with upward drift) and PERSISTED the results to signalsTable as if real —
// tradeDecision.ts then read them back as a cross-check. No signal engine is
// connected to this route, so it refuses honestly and writes no rows.
router.post("/signals/scan", (_req, res) => {
  res.json({ available: false, reason: "SIGNAL_ENGINE_NOT_CONNECTED", signals: [] });
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

export default router;
