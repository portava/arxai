// Build TT — Simulated Market Engine API.
// All endpoints return executionEnvironment="SIMULATOR". This is NEVER a real
// broker quote feed and never claims to be.
import { Router, type Request, type Response, type NextFunction } from "express";
import { readRoleFromRequest } from "../lib/security/middleware.js";

import { z } from "zod/v4";
import { marketSimulator } from "../lib/marketSimulator.js";

const router = Router();

// Admin-only gate for state-mutating simulator controls. Reads stay open
// because simulator quotes/candles are tagged executionEnvironment=SIMULATOR
// and never claim broker realism.
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = readRoleFromRequest(req);
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "Forbidden", requiredRole: "ADMIN" });
    return;
  }
  next();
}

router.get("/market/symbols", (_req, res) => res.json({ symbols: marketSimulator.symbols(), executionEnvironment: "SIMULATOR" }));

router.get("/market/quote/:symbol", (req, res) => {
  const q = marketSimulator.quote(String(req.params["symbol"] ?? ""));
  if (!q) return res.status(404).json({ error: "Unknown symbol" });
  return res.json(q);
});

router.get("/market/candles/:symbol", (req, res) => {
  const limit = Math.min(240, Math.max(1, Number(req.query["limit"]) || 60));
  const candles = marketSimulator.candlesFor(String(req.params["symbol"] ?? ""), limit);
  return res.json({ symbol: String(req.params["symbol"]).toUpperCase(), candles, executionEnvironment: "SIMULATOR" });
});

router.get("/market/session-status", (_req, res) => res.json(marketSimulator.sessionStatus()));

const VolBody = z.object({ volatility: z.enum(["LOW", "MEDIUM", "HIGH"]).optional() });

router.post("/market/simulator/start", requireAdmin, (req, res) => {
  const v = VolBody.safeParse(req.body ?? {});
  return res.json(marketSimulator.start(v.success ? v.data.volatility : undefined));
});

router.post("/market/simulator/stop", requireAdmin, (_req, res) => res.json(marketSimulator.stop()));
router.post("/market/simulator/reset", requireAdmin, (_req, res) => res.json(marketSimulator.reset()));
router.post("/market/simulator/volatility", requireAdmin, (req, res) => {
  const v = VolBody.parse(req.body ?? {});
  if (!v.volatility) return res.status(400).json({ error: "volatility required" });
  return res.json(marketSimulator.setVolatility(v.volatility));
});

export default router;
