// Phase 6 — the Approval Inbox.
//
//   GET  /api/me/approval-tickets            list my tickets
//   GET  /api/me/approval-tickets/:ticketId  read one of mine
//   POST /api/me/approval-tickets/:ticketId/approve
//   POST /api/me/approval-tickets/:ticketId/reject
//   POST /api/me/approval-tickets/:ticketId/dispatch
//
// SAFETY POSTURE.
//
// Per-user only, always. Every handler resolves the authenticated user and
// scopes the query to it — there is no admin override and no id taken from the
// request body. A ticket belonging to someone else is reported as NOT FOUND
// rather than FORBIDDEN, because "forbidden" confirms the ticket exists and
// leaks that a given id is real.
//
// Approve and reject are SEPARATE explicit acts. There is no auto-approve, no
// "approve and dispatch" convenience, and no bulk endpoint — each is a distinct
// human decision about one order.
//
// Dispatch is a SEPARATE call from approve, deliberately. Fusing them would
// mean a single request both records consent and places an order, so a retry of
// that request is indistinguishable from a second intentional order.
//
// Never returns: the Deriv token, a credential handle, bridge tokens, account
// numbers beyond the venue-safe accountRef, or any gate blob that could carry
// them. The response shape is built field by field, never by spreading a row.

import { Router, type Request, type Response } from "express";
import { approvalTicketsRepo, tradingConstitutionRepo } from "@workspace/db";

type ApprovalTicketRow = NonNullable<Awaited<ReturnType<typeof approvalTicketsRepo.findTicketById>>>;
import { requireUser } from "../lib/auth/middleware.js";
import { materialTermsFingerprint } from "@workspace/domain/safety-contracts/approvalTicket";
import { assertNoSecretLeak } from "../lib/phase6/derivDependencyResolver.js";

const router = Router();

function getUserId(req: Request): number | null {
  const authUser = (req as Request & { authUser?: { id: number } }).authUser;
  return authUser?.id ?? null;
}

/**
 * The wire shape. Built field by field ON PURPOSE.
 *
 * Spreading the row would mean every column added to approval_tickets in future
 * is published automatically — including one that carries a credential. An
 * allow-list makes exposure a deliberate edit.
 */
function toWire(t: ApprovalTicketRow) {
  return {
    ticketId: t.ticketId,
    state: t.state,
    broker: t.broker,
    accountRef: t.accountRef,
    instrument: t.instrument,
    side: t.side,
    stakeUsd: t.stakeUsd,
    multiplier: t.multiplier,
    stopLossUsd: t.stopLossUsd,
    takeProfitUsd: t.takeProfitUsd,
    referenceQuote: t.referenceQuote,
    expectedPayoutUsd: t.expectedPayoutUsd,
    scannerSignalId: t.scannerSignalId,
    rubyExplanation: t.rubyExplanation,
    riskEvaluation: t.riskEvaluation,
    constitutionVersion: t.constitutionVersion,
    gateVerdicts: t.gateVerdicts,
    gateVerdictsPassed: t.gateVerdictsPassed,
    /**
     * Surfaced as its OWN field, never folded into gateVerdictsPassed. Gate 18
     * can pass because an operator waived the risk disclosure rather than
     * because this user accepted it, and an inbox that showed those identically
     * would be presenting an operator's decision as the user's consent.
     */
    disclosureWaivedByOperator: t.disclosureWaivedByOperator,
    expiresAt: t.expiresAt,
    createdAt: t.createdAt,
    approvedAt: t.approvedAt,
    rejectedAt: t.rejectedAt,
    rejectionReason: t.rejectionReason,
    rejectionSource: t.rejectionSource,
    venueContractRef: t.venueContractRef,
    /** Intent id is lineage, not a secret — it links ticket to journal. */
    intentId: t.intentId,
  };
}

function send(res: Response, status: number, body: unknown): void {
  // Belt to the allow-list's braces: refuse to emit a credential-shaped value
  // even if a future field slips past toWire.
  assertNoSecretLeak(body, "approval-inbox response");
  res.status(status).json(body);
}

router.get("/me/approval-tickets", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (userId == null) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const rows = await approvalTicketsRepo.listInboxForUser(userId);
  send(res, 200, { tickets: rows.map(toWire) });
});

router.get("/me/approval-tickets/:ticketId", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (userId == null) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const row = await approvalTicketsRepo.findOwnedTicket(String(req.params["ticketId"]), userId);
  // 404 not 403: "forbidden" would confirm the ticket exists.
  if (!row) { res.status(404).json({ error: "TICKET_NOT_FOUND" }); return; }
  send(res, 200, { ticket: toWire(row) });
});

router.post("/me/approval-tickets/:ticketId/approve", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (userId == null) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const ticketId = String(req.params["ticketId"]);

  const row = await approvalTicketsRepo.findOwnedTicket(ticketId, userId);
  if (!row) { res.status(404).json({ error: "TICKET_NOT_FOUND" }); return; }

  // The fingerprint is derived from the PERSISTED row, never from the request
  // body. A client that could supply its own fingerprint could approve terms
  // the server never proposed.
  const fingerprint = materialTermsFingerprint({
    userId: row.userId,
    broker: row.broker,
    accountRef: row.accountRef,
    instrument: row.instrument,
    side: row.side as "BUY" | "SELL",
    stakeUsd: row.stakeUsd,
    multiplier: row.multiplier,
    stopLossUsd: row.stopLossUsd,
    takeProfitUsd: row.takeProfitUsd,
    intentId: row.intentId,
  });

  const approved = await approvalTicketsRepo.approveTicket({
    ticketId, userId, approvedByUserId: userId, approvedFingerprint: fingerprint,
  });
  if (!approved) {
    // The CAS lost: already approved, rejected, expired, dispatching, or the
    // expiry passed between the read and the write. Honest and non-specific —
    // the current state is in the GET.
    res.status(409).json({ error: "TICKET_NOT_APPROVABLE" });
    return;
  }
  send(res, 200, { ticket: toWire(approved) });
});

router.post("/me/approval-tickets/:ticketId/reject", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (userId == null) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const ticketId = String(req.params["ticketId"]);
  const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 400) : "rejected by user";

  const rejected = await approvalTicketsRepo.rejectTicket({
    ticketId, userId, rejectedByUserId: userId, reason, source: "USER",
  });
  if (!rejected) { res.status(409).json({ error: "TICKET_NOT_REJECTABLE" }); return; }
  send(res, 200, { ticket: toWire(rejected) });
});

/**
 * Dispatch an approved ticket.
 *
 * This route does NOT contain the dispatch logic. It resolves the user and
 * hands off to the guided execution service, which owns the Constitution
 * re-evaluation, the pure authorization, the CAS claim, the venue routing and
 * the adapter. Putting any of that here would create a second dispatch path,
 * and a second path is a bypass waiting to be found.
 */
router.post("/me/approval-tickets/:ticketId/dispatch", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (userId == null) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const ticketId = String(req.params["ticketId"]);

  const row = await approvalTicketsRepo.findOwnedTicket(ticketId, userId);
  if (!row) { res.status(404).json({ error: "TICKET_NOT_FOUND" }); return; }

  const { dispatchGuidedTicketForRequest } = await import("../lib/phase6/guidedDispatchEntry.js");
  const outcome = await dispatchGuidedTicketForRequest({ userId, ticketId });

  // An INDETERMINATE outcome is NOT an error and must never be rendered as one.
  // 202 says "accepted, outcome unknown" — a 4xx/5xx would invite a client
  // retry, and retrying an order that may exist is how one approval becomes two.
  const status = outcome.ok ? 200 : outcome.indeterminate ? 202 : 409;
  send(res, status, {
    ok: outcome.ok,
    indeterminate: outcome.indeterminate,
    refusal: outcome.refusal,
    detail: outcome.detail,
    venueContractRef: outcome.venueContractRef,
    intentId: outcome.intentId,
    /** Explicitly told to the client so a dry run is never shown as a trade. */
    dryRun: outcome.refusal === "TIER_FORBIDS_SEND",
  });
});

/** Read-only: the Constitution version currently governing this user. */
router.get("/me/trading-constitution", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (userId == null) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const row = await tradingConstitutionRepo.getActiveConstitution(userId);
  if (!row) { res.status(404).json({ error: "NO_CONSTITUTION" }); return; }
  send(res, 200, {
    constitution: {
      constitutionId: row.constitutionId, version: row.version,
      allowedBrokers: row.allowedBrokers, allowedInstruments: row.allowedInstruments,
      allowedMarketCategories: row.allowedMarketCategories,
      maxRiskPerTradeUsd: row.maxRiskPerTradeUsd, maxDailyLossUsd: row.maxDailyLossUsd,
      maxWeeklyLossUsd: row.maxWeeklyLossUsd,
      maxSimultaneousPositions: row.maxSimultaneousPositions,
      maxExposurePerSymbolUsd: row.maxExposurePerSymbolUsd,
      maxTradesPerDay: row.maxTradesPerDay,
      requireStopLoss: row.requireStopLoss, requireTakeProfit: row.requireTakeProfit,
      minStakeUsd: row.minStakeUsd, maxStakeUsd: row.maxStakeUsd,
      minMultiplier: row.minMultiplier, maxMultiplier: row.maxMultiplier,
      rubyAuthority: row.rubyAuthority,
      createdAt: row.createdAt,
    },
  });
});

export default router;
