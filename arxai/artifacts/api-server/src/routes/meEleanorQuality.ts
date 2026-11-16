// Task #199 — Eleanor Quality: user-facing endpoints (read-only, user-simple).
//
// SAFETY / SCOPE:
//   - requireUser; every query is scoped by req.authUser.id. No row from another
//     user is ever returned.
//   - READ-ONLY. These endpoints never place / modify / close a trade and never
//     touch the MT5 bridge or the 16-gate live pipeline.
//   - USER-SIMPLE ONLY. The admin-only `adminDetail` review blob is NEVER
//     selected or returned here — only the plain-language `userSummary`.

import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  eleanorSignalOutcomesTable,
  eleanorSignalReviewsTable,
} from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

function err(res: Response, status: number, message: string) {
  res.status(status).json({ ok: false, error: message });
}

function userId(req: Request): number | null {
  const u = (req as Request & { authUser?: { id?: number } }).authUser;
  return u?.id ?? null;
}

const outcomesQuery = z.object({
  symbol: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// ── GET /me/eleanor-quality/outcomes ──────────────────────────────────────────
router.get("/me/eleanor-quality/outcomes", requireUser, async (req, res) => {
  const uid = userId(req);
  if (uid == null) { err(res, 401, "AUTH_REQUIRED"); return; }
  const q = outcomesQuery.safeParse(req.query ?? {});
  if (!q.success) { err(res, 400, "invalid_query"); return; }

  const conds = [eq(eleanorSignalOutcomesTable.userId, uid)];
  if (q.data.symbol) conds.push(eq(eleanorSignalOutcomesTable.symbol, q.data.symbol));

  const rows = await db
    .select({
      outcomeId: eleanorSignalOutcomesTable.outcomeId,
      symbol: eleanorSignalOutcomesTable.symbol,
      timeframe: eleanorSignalOutcomesTable.timeframe,
      direction: eleanorSignalOutcomesTable.direction,
      decision: eleanorSignalOutcomesTable.decision,
      outcomeStatus: eleanorSignalOutcomesTable.outcomeStatus,
      confidenceScore: eleanorSignalOutcomesTable.confidenceScore,
      userEntered: eleanorSignalOutcomesTable.userEntered,
      createdAt: eleanorSignalOutcomesTable.createdAt,
      resolvedAt: eleanorSignalOutcomesTable.resolvedAt,
    })
    .from(eleanorSignalOutcomesTable)
    .where(and(...conds))
    .orderBy(desc(eleanorSignalOutcomesTable.createdAt))
    .limit(q.data.limit ?? 100);

  res.json({
    ok: true,
    outcomes: rows.map((r) => ({
      outcomeId: r.outcomeId,
      symbol: r.symbol,
      timeframe: r.timeframe,
      direction: r.direction,
      decision: r.decision,
      outcomeStatus: r.outcomeStatus,
      confidenceScore: r.confidenceScore,
      userEntered: r.userEntered,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    })),
  });
});

const reviewsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// ── GET /me/eleanor-quality/reviews ───────────────────────────────────────────
// User-simple ONLY: never selects adminDetail.
router.get("/me/eleanor-quality/reviews", requireUser, async (req, res) => {
  const uid = userId(req);
  if (uid == null) { err(res, 401, "AUTH_REQUIRED"); return; }
  const q = reviewsQuery.safeParse(req.query ?? {});
  if (!q.success) { err(res, 400, "invalid_query"); return; }

  const rows = await db
    .select({
      reviewId: eleanorSignalReviewsTable.reviewId,
      outcomeId: eleanorSignalReviewsTable.outcomeId,
      reviewType: eleanorSignalReviewsTable.reviewType,
      outcomeStatus: eleanorSignalReviewsTable.outcomeStatus,
      userSummary: eleanorSignalReviewsTable.userSummary,
      createdAt: eleanorSignalReviewsTable.createdAt,
    })
    .from(eleanorSignalReviewsTable)
    .where(eq(eleanorSignalReviewsTable.userId, uid))
    .orderBy(desc(eleanorSignalReviewsTable.createdAt))
    .limit(q.data.limit ?? 100);

  res.json({
    ok: true,
    reviews: rows.map((r) => ({
      reviewId: r.reviewId,
      outcomeId: r.outcomeId,
      reviewType: r.reviewType,
      outcomeStatus: r.outcomeStatus,
      userSummary: r.userSummary,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

export { router as meEleanorQualityRouter };
