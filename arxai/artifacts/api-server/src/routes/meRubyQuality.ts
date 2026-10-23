// Task #199 — Ruby Quality: user-facing endpoints (read-only, user-simple).
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
  rubySignalOutcomesTable,
  rubySignalReviewsTable,
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

// ── GET /me/ruby-quality/outcomes ──────────────────────────────────────────
router.get("/me/ruby-quality/outcomes", requireUser, async (req, res) => {
  const uid = userId(req);
  if (uid == null) { err(res, 401, "AUTH_REQUIRED"); return; }
  const q = outcomesQuery.safeParse(req.query ?? {});
  if (!q.success) { err(res, 400, "invalid_query"); return; }

  const conds = [eq(rubySignalOutcomesTable.userId, uid)];
  if (q.data.symbol) conds.push(eq(rubySignalOutcomesTable.symbol, q.data.symbol));

  const rows = await db
    .select({
      outcomeId: rubySignalOutcomesTable.outcomeId,
      symbol: rubySignalOutcomesTable.symbol,
      timeframe: rubySignalOutcomesTable.timeframe,
      direction: rubySignalOutcomesTable.direction,
      decision: rubySignalOutcomesTable.decision,
      outcomeStatus: rubySignalOutcomesTable.outcomeStatus,
      confidenceScore: rubySignalOutcomesTable.confidenceScore,
      userEntered: rubySignalOutcomesTable.userEntered,
      createdAt: rubySignalOutcomesTable.createdAt,
      resolvedAt: rubySignalOutcomesTable.resolvedAt,
    })
    .from(rubySignalOutcomesTable)
    .where(and(...conds))
    .orderBy(desc(rubySignalOutcomesTable.createdAt))
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

// ── GET /me/ruby-quality/reviews ───────────────────────────────────────────
// User-simple ONLY: never selects adminDetail.
router.get("/me/ruby-quality/reviews", requireUser, async (req, res) => {
  const uid = userId(req);
  if (uid == null) { err(res, 401, "AUTH_REQUIRED"); return; }
  const q = reviewsQuery.safeParse(req.query ?? {});
  if (!q.success) { err(res, 400, "invalid_query"); return; }

  const rows = await db
    .select({
      reviewId: rubySignalReviewsTable.reviewId,
      outcomeId: rubySignalReviewsTable.outcomeId,
      reviewType: rubySignalReviewsTable.reviewType,
      outcomeStatus: rubySignalReviewsTable.outcomeStatus,
      userSummary: rubySignalReviewsTable.userSummary,
      createdAt: rubySignalReviewsTable.createdAt,
    })
    .from(rubySignalReviewsTable)
    .where(eq(rubySignalReviewsTable.userId, uid))
    .orderBy(desc(rubySignalReviewsTable.createdAt))
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

export { router as meRubyQualityRouter };
