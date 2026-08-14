import { Router } from "express";
import { z } from "zod/v4";
import { getNewsIntelligence } from "../lib/news/newsIntelligenceService.js";

const router = Router();

const requestSchema = z.object({
  symbol: z.string().min(1).max(64),
});

router.post("/market/news-intelligence", async (req, res) => {
  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(req.body ?? {});
  } catch {
    res.status(400).json({ error: "BAD_REQUEST", message: "Invalid request." });
    return;
  }

  try {
    const pack = await getNewsIntelligence(body.symbol);
    res.json(pack);
  } catch (err) {
    req.log.error({ err: String(err) }, "newsIntelligence route failed");
    res.status(500).json({
      error: "NEWS_INTELLIGENCE_FAILED",
      message: "News intelligence is temporarily unavailable.",
    });
  }
});

export default router;
