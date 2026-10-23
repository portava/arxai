import { Router } from "express";
import { z } from "zod/v4";
import { getHistoricalAnalysis } from "../lib/marketData/historicalAnalysis.js";

const router = Router();

const requestSchema = z.object({
  symbol: z.string().min(1).max(64),
  timeframe: z.string().min(1).max(8).optional(),
  limit: z.number().int().min(200).max(5000).optional(),
});

router.post("/market/historical-analysis", async (req, res) => {
  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(req.body ?? {});
  } catch {
    res.status(400).json({ error: "BAD_REQUEST", message: "Invalid request." });
    return;
  }

  try {
    const result = await getHistoricalAnalysis({
      symbol: body.symbol,
      timeframe: body.timeframe,
      limit: body.limit,
    });
    res.json(result);
  } catch (err) {
    req.log.error({ err: String(err) }, "historicalAnalysis route failed");
    res.status(500).json({
      error: "HISTORICAL_ANALYSIS_FAILED",
      message: "Historical data is temporarily unavailable.",
    });
  }
});

export default router;
