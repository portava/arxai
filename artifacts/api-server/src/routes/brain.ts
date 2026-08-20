import { Router } from "express";
import { z } from "zod/v4";
import { analyzeMarket } from "../brain/marketBrain.js";
import { getAllSymbols, getSymbolInfo, getSymbolsByCategory } from "../brain/symbols/symbolRegistry.js";
import { attachAuthUser } from "../lib/auth/middleware.js";
import { getBrokerSymbolSpec } from "../lib/mt5/brokerSymbolSpec.js";

const router = Router();

const AnalyzeBody = z.object({
  symbol: z.string().min(1),
  minConfidence: z.number().min(0).max(100).optional(),
  enableNewsFilter: z.boolean().optional(),
  enableSessionFilter: z.boolean().optional(),
});

const SymbolsQuery = z.object({ category: z.enum(["forex", "indices", "stocks", "synthetic"]).optional() });

router.post("/brain/analyze", async (req, res) => {
  const parsed = AnalyzeBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid request", details: parsed.error.issues }); return; }
  const { symbol, ...settings } = parsed.data;
  // R7 step 1a — analyzeMarket now routes REAL candles (no synthetic default)
  // and returns { available:false, reason:"INSUFFICIENT_REAL_DATA" } when the
  // feed cannot prove enough closed bars. Both shapes serialize through as-is.
  const result = await analyzeMarket(symbol, undefined, undefined, settings);
  res.json(result);
});

router.get("/brain/symbols", (req, res) => {
  const q = SymbolsQuery.safeParse(req.query);
  if (!q.success) { res.status(400).json({ error: "Invalid query" }); return; }
  if (q.data.category) {
    res.json(getSymbolsByCategory(q.data.category));
  } else {
    res.json(getAllSymbols().map((s) => ({ symbol: s, ...getSymbolInfo(s) })));
  }
});

router.get("/brain/symbol/:symbol", attachAuthUser, async (req, res) => {
  const symbol = String(req.params.symbol);
  const info = getSymbolInfo(symbol);
  if (!info) { res.status(404).json({ error: "Symbol not found in registry" }); return; }
  // Task #30 — when a signed-in user has live broker truth synced from their
  // EA for this symbol, merge it in (per-user isolated). Anonymous callers and
  // users with no synced spec just get the static registry info.
  let broker: Awaited<ReturnType<typeof getBrokerSymbolSpec>> | null = null;
  if (req.authUser) {
    broker = await getBrokerSymbolSpec(req.authUser.id, symbol).catch(() => null);
  }
  res.json({ symbol, ...info, brokerSpec: broker?.spec ?? null, brokerTruth: broker?.hasBrokerTruth ?? false });
});

export default router;
