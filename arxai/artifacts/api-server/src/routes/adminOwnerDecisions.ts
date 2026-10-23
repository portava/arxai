// ── Owner Decision Registry routes (Blueprint Part II #54, Phase 0) ─────────
//
// ADMIN/OWNER-only surface over the APPEND-ONLY owner_decisions ledger.
// Exactly two operations exist: list (newest first) and append. There are NO
// update or delete routes and none may be added — a wrong ruling is corrected
// by appending a new row that names its predecessor via supersedesId
// (forward-fix only). The markdown mirror lives at docs/OWNER_DECISIONS.md.

import { Router, type Request, type Response } from "express";
import { db, ownerDecisionsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

const router = Router();

// ─── Admin gating helper (mirrors bridgeV2 / adminEaHealth) ─────────────────
function requireAdmin(req: Request, res: Response): "ADMIN" | "OWNER" | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  const role = String(u?.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_OR_OWNER_REQUIRED" });
    return null;
  }
  return role as "ADMIN" | "OWNER";
}

// ─── GET /api/admin/owner-decisions ─────────────────────────────────────────
// Full registry, newest ruling first. Read-only projection of the ledger.
router.get("/admin/owner-decisions", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const rows = await db
    .select()
    .from(ownerDecisionsTable)
    .orderBy(desc(ownerDecisionsTable.decidedAt), desc(ownerDecisionsTable.id))
    .limit(1000);
  res.json({ ok: true, count: rows.length, decisions: rows });
});

// ─── POST /api/admin/owner-decisions ────────────────────────────────────────
// Append one ruling. decidedBy is taken from the authenticated session, never
// from the body, so a ruling is always attributable to the operator who
// recorded it. supersedesId must name an existing row (refuse, don't guess).
router.post("/admin/owner-decisions", async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  const u = (req as Request & { authUser?: { id?: number; username?: string; email?: string } }).authUser;

  const body = (req.body ?? {}) as {
    title?: unknown;
    decision?: unknown;
    context?: unknown;
    supersedesId?: unknown;
  };

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const decision = typeof body.decision === "string" ? body.decision.trim() : "";
  if (!title || !decision) {
    res.status(400).json({ ok: false, error: "TITLE_AND_DECISION_REQUIRED" });
    return;
  }
  const context = typeof body.context === "string" && body.context.trim().length > 0
    ? body.context.trim()
    : null;

  let supersedesId: number | null = null;
  if (body.supersedesId != null) {
    const n = Number(body.supersedesId);
    if (!Number.isInteger(n) || n <= 0) {
      res.status(400).json({ ok: false, error: "SUPERSEDES_ID_INVALID" });
      return;
    }
    const [prior] = await db
      .select({ id: ownerDecisionsTable.id })
      .from(ownerDecisionsTable)
      .where(eq(ownerDecisionsTable.id, n))
      .limit(1);
    if (!prior) {
      res.status(400).json({ ok: false, error: "SUPERSEDES_ID_NOT_FOUND" });
      return;
    }
    supersedesId = n;
  }

  const decidedBy = u?.username ?? u?.email ?? (u?.id != null ? `user:${u.id}` : "UNKNOWN_SESSION");

  const [row] = await db
    .insert(ownerDecisionsTable)
    .values({ decidedBy, title, decision, context, supersedesId })
    .returning();

  res.status(201).json({ ok: true, decision: row });
});

export default router;
