// Capability #45 — comparative origin-class analytics (/api/me/trades/origin-analytics).
//
// Read-only, per-user scoped. Segments the caller's trades by origin class
// (MANUAL / ASSISTED / MODIFIED / AUTOMATED) and reports per-class expectancy
// and win rate under the pnlStatus honesty contract. Historical rows without
// a tag are an explicit UNTAGGED bucket — never guessed into a class — and
// discipline is a typed honest null until per-trade discipline telemetry
// exists.

import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, tradesTable } from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import { computeOriginClassAnalytics } from "../lib/attribution/originClassAnalytics.js";

const router = Router();

router.get("/me/trades/origin-analytics", requireUser, async (req, res) => {
  try {
    const rows = await db
      .select({
        originClass: tradesTable.originClass,
        status: tradesTable.status,
        pnl: tradesTable.pnl,
        pnlStatus: tradesTable.pnlStatus,
      })
      .from(tradesTable)
      .where(eq(tradesTable.userId, req.authUser!.id));
    const analytics = computeOriginClassAnalytics(rows);
    res.json({ ...analytics, generatedAt: new Date().toISOString() });
  } catch (err) {
    req.log.error(err);
    res.status(503).json({ error: "ORIGIN_ANALYTICS_UNAVAILABLE" });
  }
});

export default router;
