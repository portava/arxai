// Task #512 — One Truth, One Brain.
// SAFETY: requireUser (per-user gated → 401 when unauthenticated). READ-ONLY.
// This endpoint composes the existing canonical resolvers into ONE per-user
// Truth Snapshot. It never places, modifies, or closes a trade, never gates
// execution, never touches the 16-gate evaluator / MT5 bridge / attribution /
// permissions, and never fabricates data — a blind or failing source becomes an
// absent component, never a guess. Freshness is the underlying DATA timestamp,
// never the read time.
import { Router } from "express";
import { GetMeMarketTruthParams, GetMeMarketTruthQueryParams } from "@workspace/api-zod";
import { requireUser } from "../lib/auth/middleware.js";
import { getSymbolTruthSnapshot } from "../lib/truth/symbolTruthSnapshot.js";

const router = Router();

router.get("/me/market/truth/:symbol", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser?.id;
  if (userId == null) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let symbol: string;
  let tf: string;
  try {
    ({ symbol } = GetMeMarketTruthParams.parse({ symbol: req.params["symbol"] }));
    ({ tf } = GetMeMarketTruthQueryParams.parse({ tf: req.query["tf"] }));
  } catch (err) {
    req.log.warn({ err }, "invalid truth snapshot request");
    res.status(400).json({ error: "Invalid symbol or timeframe" });
    return;
  }

  try {
    const snapshot = await getSymbolTruthSnapshot(symbol, tf, userId);
    res.json(snapshot);
  } catch (err) {
    req.log.error({ err }, "truth snapshot failed");
    res.status(500).json({ error: "Truth snapshot unavailable" });
  }
});

export default router;
