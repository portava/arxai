// Admin-only Provider/API Health endpoint.
//
// GET /api/admin/providers/health
//   Returns the sanitized provider inventory + per-symbol self-test
//   results. NEVER returns raw API keys, tokens, or env values. Reasons
//   are pre-redacted by the router and truncated to 280 chars here.

import { type Request, type Response, Router } from "express";
import { getProviderHealthSnapshot } from "../lib/data/providerHealth.js";

const router: Router = Router();

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  const u = (req as unknown as { authUser?: { id: number; role?: string } }).authUser;
  if (!u) { res.status(401).json({ error: "AUTH_REQUIRED" }); return null; }
  const role = String(u.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ error: "FORBIDDEN", message: "Admin or Owner role required." });
    return null;
  }
  return { id: u.id, role: role as "ADMIN" | "OWNER" };
}

router.get("/admin/providers/health", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  try {
    const snapshot = await getProviderHealthSnapshot();
    res.json({ ok: true, snapshot });
  } catch (err) {
    // Defense-in-depth: scrub any env value that might leak via err.message.
    let msg = String((err as Error).message ?? err);
    for (const k of [
      "TWELVEDATA_API_KEY", "DERIV_APP_ID", "DERIV_API_TOKEN", "POLYGON_API_KEY",
      "FINNHUB_API_KEY", "ALPHA_VANTAGE_API_KEY", "NEWSAPI_API_KEY", "OPENAI_API_KEY",
      "SESSION_SECRET", "MT5_BRIDGE_TOKEN", "DATABASE_URL",
    ]) {
      const v = process.env[k];
      if (v && v.length >= 4 && msg.includes(v)) msg = msg.split(v).join(`<${k}_redacted>`);
    }
    msg = msg
      .replace(/app_id=[^&\s]+/gi, "app_id=<redacted>")
      .replace(/api[_-]?key=[^&\s]+/gi, "api_key=<redacted>")
      .replace(/token=[^&\s]+/gi, "token=<redacted>")
      .slice(0, 280);
    res.status(500).json({
      ok: false,
      error: "PROVIDER_HEALTH_SNAPSHOT_FAILED",
      message: msg,
    });
  }
});

export default router;
