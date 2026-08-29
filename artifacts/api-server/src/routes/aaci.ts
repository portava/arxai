// ARX Adaptive Cohesion Intelligence (AACI) — HTTP routes.
//
// GET /me/aaci/decision/:symbol      → AaciUserDecision (per-user, auth required)
// GET /admin/aaci/decision/:symbol   → AaciDecision (full diagnostic, ADMIN/OWNER)
// GET /admin/aaci/snapshot/:symbol   → AaciSharedTruthSnapshot (ADMIN/OWNER)
// GET /admin/aaci/calibration-curve  → AaciCalibrationCurveReport (ADMIN/OWNER)
//
// ADVISORY / READ-ONLY ONLY. AACI never gates live or demo execution, never
// places/modifies/closes a trade, and can only ADD caution. Every read is
// per-user isolated (authUser.id). Admin endpoints expose full diagnostic
// detail (machine codes, sub-scores) and are ADMIN/OWNER only. They gate on the
// EFFECTIVE request role (`req.authUser.role` via `normalizeProductRole`): the
// view-mode middleware downgrades a previewing admin's effective role to USER
// (stashing the real role on `realRole`), so checking the effective role makes
// admin-previewing-as-user land in the 403 branch — operator diagnostic detail
// must not be reachable while previewing. (`resolveProductRole` reads the real
// role and is intentionally used ONLY by the user-facing `/me` endpoint for
// projection, never as an admin access gate.) Mirrors adminAaciLearning.ts.

import { Router } from "express";
import { z } from "zod/v4";
import { and, desc, eq } from "drizzle-orm";
import { db, aaciDecisions } from "@workspace/db";
import {
  resolveProductRole,
  normalizeProductRole,
  isAdminProductRole,
} from "../lib/auth/productRole.js";
import { buildAaciSnapshot } from "../lib/aaci/snapshotService.js";
import { buildAaciDecision } from "../lib/aaci/decisionService.js";
import { getAaciCalibrationCurve } from "../lib/aaci/calibrationCurveService.js";
import { emitAaciUserAlerts } from "../lib/aaci/userAlerts.js";
import { logger } from "../lib/logger.js";
import {
  aaciRecommendedActionLabel,
  aaciCohesionTone,
  aaciConfidenceMultiplier,
} from "@workspace/domain/aaci";
import type { AaciActorType, AaciRecommendedAction, AaciStrategyKind } from "@workspace/domain/aaci";

const router = Router();

const symbolSchema = z.string().min(1).max(64);
const timeframeSchema = z.enum(["M1", "M5", "M15", "M30", "H1", "H4", "D1"]).default("M15");
const actionSchema = z.string().min(1).max(64).default("EVALUATE");
const strategySchema = z
  .enum([
    "flame_scalp",
    "fast_scalp",
    "m5_pullback",
    "m15_setup",
    "swing",
    "news_first_reaction",
    "post_news_confirmation",
  ])
  .optional();
const signalAgeSchema = z.coerce.number().int().min(0).optional();

function parseTimeframe(raw: unknown): "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1" {
  const parsed = timeframeSchema.safeParse(raw ?? "M15");
  return parsed.success ? parsed.data : "M15";
}

function parseAction(raw: unknown): string {
  const parsed = actionSchema.safeParse(raw ?? "EVALUATE");
  return parsed.success ? parsed.data : "EVALUATE";
}

function parseStrategy(raw: unknown): AaciStrategyKind | undefined {
  const parsed = strategySchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function parseSignalAge(raw: unknown): number {
  const parsed = signalAgeSchema.safeParse(raw);
  return parsed.success && typeof parsed.data === "number" ? parsed.data : 0;
}

// ── GET /me/aaci/decision/:symbol ────────────────────────────────────────────
// Per-user advisory cohesion verdict. Returns the clean, plain-English
// user-facing projection only (no machine codes / sub-scores).

router.get("/me/aaci/decision/:symbol", async (req, res, next) => {
  try {
    const userId = req.authUser?.id ?? 0;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const symbolParse = symbolSchema.safeParse(req.params["symbol"]);
    if (!symbolParse.success) {
      res.status(400).json({ error: "Invalid symbol" });
      return;
    }

    const role = resolveProductRole(req.authUser);
    const isAdmin = isAdminProductRole(role);
    const timeframe = parseTimeframe(req.query["timeframe"]);

    const snapshot = await buildAaciSnapshot({
      userId,
      role: isAdmin ? "admin" : "user",
      symbol: symbolParse.data,
      timeframe,
    });

    const decision = await buildAaciDecision({
      snapshot,
      userId,
      actorType: (isAdmin ? "admin" : "user") satisfies AaciActorType,
      actionRequested: parseAction(req.query["action"]),
      symbol: symbolParse.data,
      timeframe,
      strategy: parseStrategy(req.query["strategy"]),
      signalAgeMs: parseSignalAge(req.query["signalAgeMs"]),
    });

    // Advisory: surface any honest cohesion concerns to the user's inbox.
    // Fire-and-forget + fail-open — never block or fail the read.
    void emitAaciUserAlerts(decision, userId);

    // User-facing projection only — never leak machine codes or sub-scores.
    res.json({
      decisionId: decision.decisionId,
      timestamp: decision.timestamp,
      symbol: decision.symbol ?? null,
      timeframe: decision.timeframe ?? null,
      actionRequested: decision.actionRequested,
      hardGatePass: decision.hardGatePass,
      finalAaciScore: decision.finalAaciScore,
      recommendedAction: decision.recommendedAction,
      recommendedActionLabel: aaciRecommendedActionLabel(decision.recommendedAction),
      userFacingExplanation: decision.userFacingExplanation,
      requiredFollowUps: decision.requiredFollowUps,
    });
  } catch (err) {
    logger.error({ err }, "aaci: per-user decision failed");
    next(err);
  }
});

// ── GET /me/aaci/cohesion ────────────────────────────────────────────────────
// Batch advisory cohesion projection for a small set of symbols (Scanner). Each
// symbol is evaluated independently and FAILS OPEN: if one symbol's read errors,
// it is simply omitted from the results — one bad symbol never fails the batch.
// Clean projection only (label/tone/multiplier) — no machine codes or
// sub-scores. ADVISORY ONLY: this never reorders, re-ranks, or routes anything.
// It emits NO notifications (the per-symbol /decision endpoint owns that).

const COHESION_MAX_SYMBOLS = 12;

router.get("/me/aaci/cohesion", async (req, res, next) => {
  try {
    const userId = req.authUser?.id ?? 0;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const role = resolveProductRole(req.authUser);
    const isAdmin = isAdminProductRole(role);
    const timeframe = parseTimeframe(req.query["timeframe"]);

    const rawSymbols = String(req.query["symbols"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // De-dupe (case-insensitive) while preserving order, then cap.
    const seen = new Set<string>();
    const symbols: string[] = [];
    for (const s of rawSymbols) {
      const key = s.toUpperCase();
      if (seen.has(key)) continue;
      const parsed = symbolSchema.safeParse(s);
      if (!parsed.success) continue;
      seen.add(key);
      symbols.push(parsed.data);
      if (symbols.length >= COHESION_MAX_SYMBOLS) break;
    }

    const results = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const snapshot = await buildAaciSnapshot({
            userId,
            role: isAdmin ? "admin" : "user",
            symbol,
            timeframe,
          });
          const decision = await buildAaciDecision({
            snapshot,
            userId,
            actorType: (isAdmin ? "admin" : "user") satisfies AaciActorType,
            actionRequested: "EVALUATE",
            symbol,
            timeframe,
          });
          return {
            symbol,
            recommendedAction: decision.recommendedAction,
            recommendedActionLabel: aaciRecommendedActionLabel(decision.recommendedAction),
            finalAaciScore: decision.finalAaciScore,
            hardGatePass: decision.hardGatePass,
            confidenceMultiplier: aaciConfidenceMultiplier(decision.recommendedAction),
            cohesionTone: aaciCohesionTone(decision.recommendedAction),
          };
        } catch (err) {
          // Per-symbol fail-open — drop this symbol, keep the rest.
          logger.warn({ err, symbol }, "aaci: cohesion symbol failed (omitted)");
          return null;
        }
      }),
    );

    res.json({ results: results.filter((r): r is NonNullable<typeof r> => r != null) });
  } catch (err) {
    logger.error({ err }, "aaci: batch cohesion failed");
    next(err);
  }
});

// ── GET /admin/aaci/decision/:symbol ─────────────────────────────────────────
// Full diagnostic decision (all sub-scores, validity factors, hard-gate codes,
// conflicts, stale inputs, handshakes). ADMIN/OWNER only.

router.get("/admin/aaci/decision/:symbol", async (req, res, next) => {
  try {
    const userId = req.authUser?.id ?? 0;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const role = normalizeProductRole(req.authUser?.role);
    if (!isAdminProductRole(role)) {
      res.status(403).json({ error: "Admin or owner access required" });
      return;
    }

    const symbolParse = symbolSchema.safeParse(req.params["symbol"]);
    if (!symbolParse.success) {
      res.status(400).json({ error: "Invalid symbol" });
      return;
    }

    const timeframe = parseTimeframe(req.query["timeframe"]);

    const snapshot = await buildAaciSnapshot({
      userId,
      role: "admin",
      symbol: symbolParse.data,
      timeframe,
    });

    const decision = await buildAaciDecision({
      snapshot,
      userId,
      actorType: "admin",
      actionRequested: parseAction(req.query["action"]),
      symbol: symbolParse.data,
      timeframe,
      strategy: parseStrategy(req.query["strategy"]),
      signalAgeMs: parseSignalAge(req.query["signalAgeMs"]),
    });

    res.json(decision);
  } catch (err) {
    logger.error({ err }, "aaci: admin decision failed");
    next(err);
  }
});

// ── GET /admin/aaci/snapshot/:symbol ─────────────────────────────────────────
// The composed Shared Truth Snapshot (cross-system state). ADMIN/OWNER only.

router.get("/admin/aaci/snapshot/:symbol", async (req, res, next) => {
  try {
    const userId = req.authUser?.id ?? 0;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const role = normalizeProductRole(req.authUser?.role);
    if (!isAdminProductRole(role)) {
      res.status(403).json({ error: "Admin or owner access required" });
      return;
    }

    const symbolParse = symbolSchema.safeParse(req.params["symbol"]);
    if (!symbolParse.success) {
      res.status(400).json({ error: "Invalid symbol" });
      return;
    }

    const snapshot = await buildAaciSnapshot({
      userId,
      role: "admin",
      symbol: symbolParse.data,
      timeframe: parseTimeframe(req.query["timeframe"]),
    });

    res.json(snapshot);
  } catch (err) {
    logger.error({ err }, "aaci: admin snapshot failed");
    next(err);
  }
});

// ── GET /admin/aaci/calibration-curve ────────────────────────────────────────
// Reliability curve over REAL resolution records (CLOSED self-trade executions
// joined to their decisions' stated confidence). ADVISORY / journal-display
// only — nothing consumes it as authority. Below the domain minimums, or on a
// failed read, the response is an honest INSUFFICIENT_HISTORY with a typed
// reason (readError), never a synthesized curve. ADMIN/OWNER only.

router.get("/admin/aaci/calibration-curve", async (req, res, next) => {
  try {
    const userId = req.authUser?.id ?? 0;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const role = normalizeProductRole(req.authUser?.role);
    if (!isAdminProductRole(role)) {
      res.status(403).json({ error: "Admin or owner access required" });
      return;
    }

    res.json(await getAaciCalibrationCurve());
  } catch (err) {
    logger.error({ err }, "aaci: calibration curve failed");
    next(err);
  }
});

// ── GET /admin/aaci/decisions ────────────────────────────────────────────────
// Recent persisted AACI decisions (append-only evidence) for operator review of
// the advisory execution gate + manual advisory paths. ADMIN/OWNER only.

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  actorType: z.enum(["user", "ruby", "self_trade_agent", "admin", "system"]).optional(),
  symbol: z.string().min(1).max(64).optional(),
});

router.get("/admin/aaci/decisions", async (req, res, next) => {
  try {
    const userId = req.authUser?.id ?? 0;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const role = normalizeProductRole(req.authUser?.role);
    if (!isAdminProductRole(role)) {
      res.status(403).json({ error: "Admin or owner access required" });
      return;
    }

    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query" });
      return;
    }
    const { limit, actorType, symbol } = parsed.data;

    const filters = [
      actorType ? eq(aaciDecisions.actorType, actorType) : undefined,
      symbol ? eq(aaciDecisions.symbol, symbol) : undefined,
    ].filter((f): f is NonNullable<typeof f> => f != null);

    const rows = await db
      .select({
        decisionId: aaciDecisions.decisionId,
        createdAt: aaciDecisions.createdAt,
        userId: aaciDecisions.userId,
        actorType: aaciDecisions.actorType,
        actorId: aaciDecisions.actorId,
        symbol: aaciDecisions.symbol,
        timeframe: aaciDecisions.timeframe,
        actionRequested: aaciDecisions.actionRequested,
        hardGatePass: aaciDecisions.hardGatePass,
        finalAaciScore: aaciDecisions.finalAaciScore,
        recommendedAction: aaciDecisions.recommendedAction,
      })
      .from(aaciDecisions)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(aaciDecisions.createdAt))
      .limit(limit);

    res.json({
      decisions: rows.map((r) => ({
        decisionId: r.decisionId,
        createdAt: r.createdAt.toISOString(),
        userId: r.userId,
        actorType: r.actorType,
        actorId: r.actorId,
        symbol: r.symbol,
        timeframe: r.timeframe,
        actionRequested: r.actionRequested,
        hardGatePass: r.hardGatePass,
        finalAaciScore: r.finalAaciScore,
        recommendedAction: r.recommendedAction,
        recommendedActionLabel: aaciRecommendedActionLabel(
          r.recommendedAction as AaciRecommendedAction,
        ),
      })),
    });
  } catch (err) {
    logger.error({ err }, "aaci: admin decisions list failed");
    next(err);
  }
});

export default router;
