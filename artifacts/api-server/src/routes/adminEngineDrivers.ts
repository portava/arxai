// Admin — Engine Drivers surfaces (#58 / #34 / #15 / #16)
//
// SAFETY (inviolable):
//   - All handlers are ADMIN/OWNER-gated.
//   - GET handlers are read-only over the evidence/posture tables.
//   - The ONLY mutating handler is POST /admin/recovery-probation/advance —
//     the OWNER-PRESS seam of the graduated probation ladder (#34). It moves
//     exactly ONE stage toward authority per press, requires { confirm: true }
//     + a reason, is dwell-gated, and writes a before/after audit row.
//     Automatic code paths may only TIGHTEN probation; they never call this.
//   - A missing table (docs/migrations-pending/build-engine-drivers.sql not
//     applied) answers 503 with the exact remedy, never a fabricated empty
//     "all good" payload.
import express, { type IRouter, Router, type Request, type Response } from "express";
import { desc } from "drizzle-orm";
import {
  db,
  adminActionAuditLogTable,
  intelligenceRoiRecordsTable,
  intelligenceRoiPassesTable,
  championChallengerPairsTable,
  metaStrategyStatesTable,
} from "@workspace/db";
import {
  readActiveProbation,
  advanceRecoveryProbationOneStage,
} from "../lib/recoveryProbation.js";

const router: IRouter = Router();
router.use(express.json());

function requireAdmin(
  req: Request,
  res: Response,
): { id: number; role: "ADMIN" | "OWNER" } | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return null;
  }
  const role = sess.role ?? null;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: sess.id, role };
}

function missingTable(err: unknown): boolean {
  const probe = (o: unknown): boolean =>
    !!o && typeof o === "object" && "code" in o && (o as { code: unknown }).code === "42P01";
  return probe(err) || probe((err as { cause?: unknown } | null)?.cause);
}

function tableMissingResponse(res: Response): void {
  res.status(503).json({
    ok: false,
    error: "ENGINE_DRIVER_TABLES_MISSING",
    detail:
      "The engine-driver tables do not exist in this database yet. Apply docs/migrations-pending/build-engine-drivers.sql via raw psql (drizzle-kit push is broken against the dev DB).",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// #58 — GET /api/admin/intelligence-roi
// Latest governor verdict (ADVISORY) + the most recent per-component records.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/intelligence-roi", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  try {
    const [latestPass] = await db
      .select()
      .from(intelligenceRoiPassesTable)
      .orderBy(desc(intelligenceRoiPassesTable.id))
      .limit(1);
    const records = await db
      .select()
      .from(intelligenceRoiRecordsTable)
      .orderBy(desc(intelligenceRoiRecordsTable.id))
      .limit(100);
    res.json({
      ok: true,
      advisoryOnly: true,
      latestPass: latestPass ?? null,
      records,
      note:
        latestPass == null && records.length === 0
          ? "No ROI ledger entries yet — either no component activity has been observed or the worker has not completed a pass."
          : undefined,
    });
  } catch (err) {
    if (missingTable(err)) return tableMissingResponse(res);
    res.status(500).json({ ok: false, error: "READ_FAILED", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #34 — GET /api/admin/recovery-probation
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/recovery-probation", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const read = await readActiveProbation();
  if (!read.ok) {
    if (read.missingTable) return tableMissingResponse(res);
    res.status(500).json({ ok: false, error: "READ_FAILED", detail: read.reason });
    return;
  }
  res.json({
    ok: true,
    active: read.row != null,
    probation: read.row ?? null,
    ladder: ["BLOCK_ALL", "PAPER_ONLY", "A_PLUS_ONLY", "REDUCED_SIZE", "NORMAL(exit)"],
    note: "Automatic transitions only ever tighten; each advance toward authority is one owner press on POST /api/admin/recovery-probation/advance.",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #34 — POST /api/admin/recovery-probation/advance   (OWNER-PRESS seam)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/recovery-probation/advance", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.confirm !== true) {
    res.status(400).json({
      ok: false,
      error: "CONFIRMATION_REQUIRED",
      detail: "Send { confirm: true, reason: \"...\" } — advancing probation widens authority by exactly one stage.",
    });
    return;
  }
  const reason = typeof body.reason === "string" && body.reason.trim().length > 0
    ? body.reason.trim().slice(0, 500)
    : null;
  if (!reason) {
    res.status(400).json({ ok: false, error: "REASON_REQUIRED", detail: "A non-empty reason is required for the audit trail." });
    return;
  }
  try {
    const before = await readActiveProbation();
    const result = await advanceRecoveryProbationOneStage({
      actor: `admin:${admin.id}`,
      reason,
    });
    if (!result.ok) {
      res.status(409).json({ ok: false, error: "ADVANCE_REFUSED", detail: result.reason });
      return;
    }
    await db.insert(adminActionAuditLogTable).values({
      adminId: admin.id,
      adminRole: admin.role,
      action: "ADMIN_ADVANCED_RECOVERY_PROBATION",
      beforeState: { stage: result.fromStage, row: (before.ok ? before.row : null) ?? null },
      afterState: { stage: result.toStage, exited: result.exited, reason },
    });
    res.json({
      ok: true,
      fromStage: result.fromStage,
      toStage: result.toStage,
      exited: result.exited,
      note: result.exited
        ? "Probation exited — full authority is restored ONLY through the ordinary gates, which never stopped running."
        : "Advanced one stage. Further widening requires another press after the stage dwell.",
    });
  } catch (err) {
    if (missingTable(err)) return tableMissingResponse(res);
    res.status(500).json({ ok: false, error: "ADVANCE_FAILED", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #15 — GET /api/admin/champion-challenger
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/champion-challenger", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  try {
    const pairs = await db
      .select()
      .from(championChallengerPairsTable)
      .orderBy(desc(championChallengerPairsTable.id))
      .limit(200);
    // Per-strategy rollup over the returned page (evidence only).
    const byStrategy = new Map<string, { pairs: number; netEdgeR: number; avoidedLosers: number; missedWinners: number }>();
    for (const p of pairs) {
      const s = byStrategy.get(p.challengerStrategy) ?? { pairs: 0, netEdgeR: 0, avoidedLosers: 0, missedWinners: 0 };
      s.pairs += 1;
      s.netEdgeR += p.challengerEdgeR ?? 0;
      if (p.judgment === "CANDIDATE_AVOIDED_LOSER") s.avoidedLosers += 1;
      if (p.judgment === "CANDIDATE_MISSED_WINNER") s.missedWinners += 1;
      byStrategy.set(p.challengerStrategy, s);
    }
    res.json({
      ok: true,
      evidenceOnly: true,
      pairs,
      summaryByStrategy: Object.fromEntries(byStrategy),
      note: pairs.length === 0
        ? "No paired outcomes yet — pairs require closed executed mission drafts AND resolved shadow predictions on the same symbol/window."
        : undefined,
    });
  } catch (err) {
    if (missingTable(err)) return tableMissingResponse(res);
    res.status(500).json({ ok: false, error: "READ_FAILED", detail: err instanceof Error ? err.message : String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #16 — GET /api/admin/meta-strategy
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/meta-strategy", async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  try {
    const states = await db
      .select()
      .from(metaStrategyStatesTable)
      .orderBy(desc(metaStrategyStatesTable.updatedAt))
      .limit(200);
    res.json({
      ok: true,
      states,
      note: "appliedState only ever moves toward LESS authority automatically; recommendedState with more authority awaits the owner-gated promotion machinery.",
    });
  } catch (err) {
    if (missingTable(err)) return tableMissingResponse(res);
    res.status(500).json({ ok: false, error: "READ_FAILED", detail: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
