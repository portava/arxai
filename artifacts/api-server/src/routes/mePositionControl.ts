// Capability #44 — manual takeover as a first-class state (/api/me/positions/control/*).
//
//   GET  /me/positions/control                       — control state of open positions
//   POST /me/positions/control/:brokerTicket/takeover — stop strategy management
//   POST /me/positions/control/:brokerTicket/release  — explicit hand-back
//
// Both transitions are explicit owner presses, per-user scoped (userId +
// brokerTicket), journaled to the vault, and refuse on stale state instead of
// silently overwriting. While MANUAL_CONTROL is active, missionExitManager and
// every future automated management seam refuse via
// checkAutomatedCommandAllowed — this route only flips and journals the state,
// it never touches the broker.

import { Router } from "express";
import { z } from "zod/v4";
import { and, eq, isNull } from "drizzle-orm";
import { db, arxLivePositionsTable } from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import {
  planTakeover,
  planRelease,
  normalizeManagementState,
} from "@workspace/domain/self-trade";
import { shadowCaptureFAF } from "../lib/auditVault.js";

const router = Router();

const TicketParam = z.string().min(1).max(64);
const TakeoverBody = z.object({ reason: z.string().max(500).optional() });

async function loadOwnPosition(userId: number, brokerTicket: string) {
  const rows = await db
    .select()
    .from(arxLivePositionsTable)
    .where(and(eq(arxLivePositionsTable.userId, userId), eq(arxLivePositionsTable.brokerTicket, brokerTicket)))
    .limit(1);
  return rows[0] ?? null;
}

function serializeControl(row: {
  brokerTicket: string; symbol: string; managementState: string;
  manualTakeoverAt: Date | null; manualTakeoverReason: string | null; manualReleaseAt: Date | null;
  closedAt: Date | null;
}) {
  return {
    brokerTicket: row.brokerTicket,
    symbol: row.symbol,
    managementState: normalizeManagementState(row.managementState),
    manualTakeoverAt: row.manualTakeoverAt?.toISOString() ?? null,
    manualTakeoverReason: row.manualTakeoverReason,
    manualReleaseAt: row.manualReleaseAt?.toISOString() ?? null,
    open: row.closedAt == null,
  };
}

// ── GET /me/positions/control ───────────────────────────────────────────────
router.get("/me/positions/control", requireUser, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(arxLivePositionsTable)
      .where(and(eq(arxLivePositionsTable.userId, req.authUser!.id), isNull(arxLivePositionsTable.closedAt)));
    res.json({
      positions: rows.map(serializeControl),
      note: "MANUAL_CONTROL suspends automated management for that position only; protective monitoring continues. Release is an explicit press.",
    });
  } catch (err) {
    req.log.error(err);
    res.status(503).json({ error: "POSITION_CONTROL_UNREADABLE" });
  }
});

// ── POST /me/positions/control/:brokerTicket/takeover ───────────────────────
router.post("/me/positions/control/:brokerTicket/takeover", requireUser, async (req, res) => {
  const ticket = TicketParam.safeParse(req.params.brokerTicket);
  const body = TakeoverBody.safeParse(req.body ?? {});
  if (!ticket.success || !body.success) {
    res.status(400).json({ error: "INVALID_REQUEST" });
    return;
  }
  try {
    const userId = req.authUser!.id;
    const row = await loadOwnPosition(userId, ticket.data);
    if (!row) { res.status(404).json({ error: "POSITION_NOT_FOUND" }); return; }

    const plan = planTakeover({ state: row.managementState, closed: row.closedAt != null });
    if (!plan.ok) {
      res.status(409).json({ error: plan.reason });
      return;
    }
    const now = new Date();
    const updated = await db
      .update(arxLivePositionsTable)
      .set({
        managementState: plan.to,
        manualTakeoverAt: now,
        manualTakeoverReason: body.data.reason ?? null,
      })
      .where(and(
        eq(arxLivePositionsTable.id, row.id),
        eq(arxLivePositionsTable.userId, userId),
        // Optimistic guard: only flip a row still in the state the plan saw,
        // so two concurrent presses cannot both "win".
        eq(arxLivePositionsTable.managementState, row.managementState),
      ))
      .returning();
    if (!updated[0]) { res.status(409).json({ error: "STATE_CHANGED_RETRY" }); return; }

    // Journal the handover (append-only vault).
    shadowCaptureFAF({
      eventType: "POSITION_MANUAL_TAKEOVER",
      source: "position-control",
      severity: "WARN",
      systemMode: null,
      globalState: null,
      payload: {
        userId, brokerTicket: row.brokerTicket, symbol: row.symbol,
        from: plan.from, to: plan.to, reason: body.data.reason ?? null,
        at: now.toISOString(),
      },
    });
    res.json({ control: serializeControl(updated[0]), journaled: true });
  } catch (err) {
    req.log.error(err);
    res.status(503).json({ error: "POSITION_CONTROL_UNREADABLE" });
  }
});

// ── POST /me/positions/control/:brokerTicket/release ────────────────────────
router.post("/me/positions/control/:brokerTicket/release", requireUser, async (req, res) => {
  const ticket = TicketParam.safeParse(req.params.brokerTicket);
  if (!ticket.success) { res.status(400).json({ error: "INVALID_REQUEST" }); return; }
  try {
    const userId = req.authUser!.id;
    const row = await loadOwnPosition(userId, ticket.data);
    if (!row) { res.status(404).json({ error: "POSITION_NOT_FOUND" }); return; }

    const plan = planRelease({ state: row.managementState, closed: row.closedAt != null });
    if (!plan.ok) {
      res.status(409).json({ error: plan.reason });
      return;
    }
    const now = new Date();
    const updated = await db
      .update(arxLivePositionsTable)
      .set({ managementState: plan.to, manualReleaseAt: now })
      .where(and(
        eq(arxLivePositionsTable.id, row.id),
        eq(arxLivePositionsTable.userId, userId),
        eq(arxLivePositionsTable.managementState, "MANUAL_CONTROL"),
      ))
      .returning();
    if (!updated[0]) { res.status(409).json({ error: "STATE_CHANGED_RETRY" }); return; }

    shadowCaptureFAF({
      eventType: "POSITION_MANUAL_RELEASE",
      source: "position-control",
      severity: "INFO",
      systemMode: null,
      globalState: null,
      payload: {
        userId, brokerTicket: row.brokerTicket, symbol: row.symbol,
        from: plan.from, to: plan.to, at: now.toISOString(),
      },
    });
    res.json({ control: serializeControl(updated[0]), journaled: true });
  } catch (err) {
    req.log.error(err);
    res.status(503).json({ error: "POSITION_CONTROL_UNREADABLE" });
  }
});

export default router;
