// Public per-user tradability endpoint. Returns the same fields the
// trade ticket badge, scanner card label, and Ruby market-context
// pipeline consume so they cannot drift apart.
import { Router } from "express";
import { getSymbolTradability } from "../lib/data/symbolTradability.js";

const router = Router();

router.get("/market-data/tradability", async (req, res) => {
  const userId = (req as unknown as { authUser?: { id: number } }).authUser?.id;
  const symbol = String((req.query.symbol as string) ?? "").trim();
  if (!symbol) {
    return res.status(400).json({ ok: false, error: "missing_symbol" });
  }
  try {
    const t = await getSymbolTradability(symbol, userId);
    return res.json({ ok: true, ...t });
  } catch (e) {
    req.log?.warn?.({ err: (e as Error).message }, "tradability lookup failed");
    return res.status(500).json({ ok: false, error: "tradability_lookup_failed" });
  }
});

export default router;
