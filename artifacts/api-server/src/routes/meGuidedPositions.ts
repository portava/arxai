// Phase 6 — guided positions, journal and debrief.
//
//   GET /api/me/guided-positions          the position centre
//   GET /api/me/guided-journal            recent attempts
//   GET /api/me/guided-journal/:intentId  one attempt, fully reconstructed
//   GET /api/me/guided-debrief/:intentId  the post-trade debrief
//
// EVERY STATE IS DERIVED FROM THE LEDGER, never inferred from absence.
//
// The three inferences this surface must never make:
//   - portfolio absence = NO POSITION. An order that opened and settled is
//     missing from an open-positions read, so absence proves nothing.
//   - sell attempted = CLOSED. An attempt is not an outcome.
//   - adapter threw = NO TRADE. A throw says nothing about transmission.
//
// None of them is reachable here because nothing on this surface reads a venue
// portfolio at all. State comes from positionStateForEvent over the recorded
// events, and UNRESOLVED is a first-class value with its own honest label.

import { Router, type Request } from "express";
import { guidedAttemptEventsRepo } from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import {
  reconstructAttempt, positionStateLabel,
  type GuidedAuditEvent, type GuidedLineageRecord,
} from "../lib/phase6/guidedLineage.js";
import { assertNoSecretLeak } from "../lib/phase6/derivDependencyResolver.js";

const router = Router();

function getUserId(req: Request): number | null {
  const authUser = (req as Request & { authUser?: { id: number } }).authUser;
  return authUser?.id ?? null;
}

type EventRow = Awaited<ReturnType<typeof guidedAttemptEventsRepo.listAttemptEvents>>[number];

function toRecord(r: EventRow): GuidedLineageRecord {
  return {
    intentId: r.intentId,
    ticketId: r.ticketId,
    userId: r.userId,
    liveCommandId: r.liveCommandId,
    event: r.eventType as GuidedAuditEvent,
    occurredAtIso: r.occurredAt.toISOString(),
    constitutionVersion: r.constitutionVersion,
    venueContractRef: r.venueContractRef,
    detail: r.detail,
    scannerSignalId: r.scannerSignalId,
    rubyExplanation: r.rubyExplanation,
  };
}

/** One attempt, presented honestly. */
function present(records: GuidedLineageRecord[]) {
  const a = reconstructAttempt(records);
  return {
    intentId: a.intentId,
    ticketId: records[0]?.ticketId ?? null,
    state: a.state,
    /** Human text. UNRESOLVED never reads as no-trade, failed or closed. */
    stateLabel: positionStateLabel(a.state),
    /**
     * Venue-proven only. Null means nothing proved a contract exists — it is
     * NOT a claim that no order was placed, and `state` carries that
     * distinction.
     */
    venueContractRef: a.venueContractRef,
    /** False while the outcome is still uncertain, however old the attempt is. */
    complete: a.complete,
    /** True when a human must intervene; a poll will not settle it. */
    needsReconciliation: a.state === "UNRESOLVED" || a.state === "RECONCILIATION_REQUIRED",
    events: records.map((r) => ({
      event: r.event,
      occurredAtIso: r.occurredAtIso,
      detail: r.detail,
      venueContractRef: r.venueContractRef,
    })),
  };
}

router.get("/me/guided-positions", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (userId == null) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const recent = await guidedAttemptEventsRepo.listRecentAttemptsForUser(userId, 200);
  const byIntent = new Map<string, EventRow[]>();
  for (const r of recent) {
    const list = byIntent.get(r.intentId) ?? [];
    list.push(r);
    byIntent.set(r.intentId, list);
  }
  const positions = [...byIntent.values()]
    .map((rows) => present(rows.sort((a, b) => a.sequenceNo - b.sequenceNo).map(toRecord)));
  const body = {
    positions,
    /**
     * Surfaced at the top level so a UI cannot bury it. An outstanding
     * unresolved attempt blocks new orders for this user, and the trader is
     * entitled to know that without opening each row.
     */
    unresolvedCount: positions.filter((p) => p.needsReconciliation).length,
  };
  assertNoSecretLeak(body, "guided-positions response");
  res.status(200).json(body);
});

router.get("/me/guided-journal", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (userId == null) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const recent = await guidedAttemptEventsRepo.listRecentAttemptsForUser(userId, 200);
  const body = {
    entries: recent.map((r) => ({
      intentId: r.intentId, ticketId: r.ticketId, event: r.eventType,
      occurredAtIso: r.occurredAt.toISOString(), detail: r.detail,
      constitutionVersion: r.constitutionVersion,
      venueContractRef: r.venueContractRef,
      scannerSignalId: r.scannerSignalId,
    })),
  };
  assertNoSecretLeak(body, "guided-journal response");
  res.status(200).json(body);
});

router.get("/me/guided-journal/:intentId", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (userId == null) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  // Owner-scoped in the QUERY. An attempt belonging to someone else is 404,
  // not 403 — "forbidden" would confirm the intent id is real.
  const rows = await guidedAttemptEventsRepo.listUserAttemptEvents(
    userId, String(req.params["intentId"]));
  if (rows.length === 0) { res.status(404).json({ error: "ATTEMPT_NOT_FOUND" }); return; }
  const body = { attempt: present(rows.map(toRecord)) };
  assertNoSecretLeak(body, "guided-journal detail response");
  res.status(200).json(body);
});

router.get("/me/guided-debrief/:intentId", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (userId == null) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const rows = await guidedAttemptEventsRepo.listUserAttemptEvents(
    userId, String(req.params["intentId"]));
  if (rows.length === 0) { res.status(404).json({ error: "ATTEMPT_NOT_FOUND" }); return; }

  const records = rows.map(toRecord);
  const a = reconstructAttempt(records);
  const first = records[0];

  const body = {
    debrief: {
      intentId: a.intentId,
      state: a.state,
      stateLabel: positionStateLabel(a.state),
      /**
       * A debrief on an UNRESOLVED attempt must not draw lessons from an
       * outcome nobody knows. Analysis is withheld rather than invented, and
       * the reason is stated — silence would read as "nothing to say".
       */
      analysisAvailable: a.complete,
      analysisWithheldReason: a.complete
        ? null
        : "the outcome is not yet established; a debrief drawn from an unknown result would be a guess",
      setup: first?.scannerSignalId ?? null,
      rubyExplanation: first?.rubyExplanation ?? null,
      constitutionVersion: first?.constitutionVersion ?? null,
      venueContractRef: a.venueContractRef,
      timeline: records.map((r) => ({ event: r.event, at: r.occurredAtIso, detail: r.detail })),
    },
  };
  assertNoSecretLeak(body, "guided-debrief response");
  res.status(200).json(body);
});

export default router;
