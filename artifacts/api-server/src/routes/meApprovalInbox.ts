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
import {
  evaluateConstitution, constitutionIsWellFormed,
  type TradingConstitution,
} from "@workspace/domain/safety-contracts/tradingConstitution";
import { randomUUID } from "node:crypto";
import { assertNoSecretLeak, screenFreeText } from "../lib/phase6/derivDependencyResolver.js";

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
    rubyExplanation: screenFreeText(t.rubyExplanation),
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
    rejectionReason: screenFreeText(t.rejectionReason),
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
  let outcome;
  try {
    outcome = await dispatchGuidedTicketForRequest({ userId, ticketId });
  } catch (e) {
    // An unexpected throw here cannot say whether a frame was sent, so the
    // response must not claim either way — and must NOT invite a retry.
    res.status(500).json({
      ok: false,
      indeterminate: true,
      refusal: "DISPATCH_ERROR",
      detail: "the dispatch failed unexpectedly — do NOT retry; check the ticket state before any further action",
    });
    return;
  }

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

/** How long a proposal stays actionable. Short on purpose: a quote goes stale,
 *  and an approval given against a stale quote is an approval for a trade the
 *  user did not actually see. */
const PROPOSAL_TTL_MS = 5 * 60_000;

/**
 * Propose a guided trade — the FIRST Constitution evaluation.
 *
 * The client supplies what it wants to trade. It does NOT supply the intent id,
 * the expiry, the constitution version, the gate verdicts or the fingerprint:
 * every one of those is server-derived, because each is something the ticket
 * ASSERTS rather than something the requester gets to choose.
 *
 * A proposal that the Constitution refuses creates NO ticket. An inbox full of
 * tickets that could never execute trains a user to click through refusals.
 */
router.post("/me/approval-tickets", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (userId == null) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }

  const b = (req.body ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);
  const optNum = (v: unknown): number | null =>
    v === null || v === undefined ? null : (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN);

  const instrument = typeof b["instrument"] === "string" ? b["instrument"] : "";
  const side = b["side"] === "BUY" || b["side"] === "SELL" ? b["side"] : null;
  const accountRef = typeof b["accountRef"] === "string" ? b["accountRef"] : "";
  const broker = typeof b["broker"] === "string" ? b["broker"] : "deriv";
  const stakeUsd = num(b["stakeUsd"]);
  const multiplier = num(b["multiplier"]);
  const stopLossUsd = optNum(b["stopLossUsd"]);
  const takeProfitUsd = optNum(b["takeProfitUsd"]);
  const marketCategory = typeof b["marketCategory"] === "string" ? b["marketCategory"] : "";

  if (!instrument || !side || !accountRef || !marketCategory
      || Number.isNaN(stakeUsd) || Number.isNaN(multiplier)
      || Number.isNaN(stopLossUsd as number) || Number.isNaN(takeProfitUsd as number)) {
    res.status(400).json({ error: "INVALID_PROPOSAL" });
    return;
  }

  const conRow = await tradingConstitutionRepo.getActiveConstitution(userId);
  if (!conRow) {
    // No policy means no permission. Not "no limits".
    res.status(409).json({ error: "NO_CONSTITUTION", detail: "set a trading constitution first" });
    return;
  }
  const constitution = {
    constitutionId: conRow.constitutionId, userId: conRow.userId, version: conRow.version,
    allowedBrokers: conRow.allowedBrokers, allowedAccountRefs: conRow.allowedAccountRefs,
    allowedInstruments: conRow.allowedInstruments, allowedMarketCategories: conRow.allowedMarketCategories,
    allowedSessionsUtc: conRow.allowedSessionsUtc,
    maxRiskPerTradeUsd: conRow.maxRiskPerTradeUsd, maxDailyLossUsd: conRow.maxDailyLossUsd,
    maxWeeklyLossUsd: conRow.maxWeeklyLossUsd,
    maxSimultaneousPositions: conRow.maxSimultaneousPositions,
    maxExposurePerSymbolUsd: conRow.maxExposurePerSymbolUsd, maxTradesPerDay: conRow.maxTradesPerDay,
    requireStopLoss: conRow.requireStopLoss, requireTakeProfit: conRow.requireTakeProfit,
    minStakeUsd: conRow.minStakeUsd, maxStakeUsd: conRow.maxStakeUsd,
    minMultiplier: conRow.minMultiplier, maxMultiplier: conRow.maxMultiplier,
    lossStreakCooldown: conRow.lossStreakCooldown,
    forbiddenInstruments: conRow.forbiddenInstruments, forbiddenConditions: conRow.forbiddenConditions,
    rubyAuthority: conRow.rubyAuthority,
  } as unknown as TradingConstitution;

  const verdict = evaluateConstitution(
    constitution,
    {
      userId, broker, accountRef, instrument, marketCategory, side,
      stakeUsd, multiplier, riskUsd: stakeUsd,
      hasStopLoss: stopLossUsd !== null, hasTakeProfit: takeProfitUsd !== null,
      conditions: [],
    },
    {
      // Observed state at PROPOSAL time. Zeroes here are honest only because a
      // fresh guided account has no history; the DISPATCH evaluation re-reads
      // real state, and that is the one that gates the order.
      nowIso: new Date().toISOString(),
      realisedDailyLossUsd: 0, realisedWeeklyLossUsd: 0,
      openPositionCount: 0, openExposureForSymbolUsd: 0,
      tradesTakenToday: 0, consecutiveLosses: 0, lastLossAtIso: null,
    },
  );
  if (verdict.decision !== "PERMIT") {
    res.status(409).json({
      error: "CONSTITUTION_REFUSED", refusals: verdict.refusals,
      constitutionVersion: verdict.constitutionVersion,
    });
    return;
  }

  // Gate 18 at PROPOSAL time. Creating a ticket that could never dispatch
  // trains the user to click through refusals; refusing here says exactly what
  // to fix. The audit found the parity map claimed this gate was enforced
  // while nothing on the guided path read the acceptances table.
  const { disclosureStatus } = await import("../lib/phase6/guidedDispatchEntry.js");
  const disclosure = await disclosureStatus(userId);
  if (!disclosure.accepted && !disclosure.waivedByOperator) {
    res.status(409).json({
      error: "DISCLOSURE_NOT_ACCEPTED",
      detail: "accept the live-trading risk disclosure before proposing a guided trade",
    });
    return;
  }

  const ticketId = `tkt_${randomUUID()}`;
  const created = await approvalTicketsRepo.createTicket({
    ticketId,
    userId,
    state: "PENDING",
    broker, accountRef, instrument, side,
    stakeUsd, multiplier, stopLossUsd, takeProfitUsd,
    // Server-derived. A client-chosen intent id could collide with, or
    // impersonate, another attempt's lineage.
    intentId: `di_${ticketId}`,
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    constitutionVersion: conRow.version,
    // What was ACTUALLY evaluated, named as such. The earlier version wrote
    // gateVerdictsPassed: true unconditionally — a record asserting all 23
    // gates passed when only the Constitution had been consulted.
    gateVerdicts: {
      constitution: { decision: "PERMIT", version: conRow.version },
      disclosure: disclosure.accepted ? "ACCEPTED" : "OPERATOR_WAIVED",
    },
    gateVerdictsPassed: true,
    disclosureWaivedByOperator: !disclosure.accepted && disclosure.waivedByOperator,
    scannerSignalId: typeof b["scannerSignalId"] === "string" ? b["scannerSignalId"] : null,
    rubyExplanation: typeof b["rubyExplanation"] === "string" ? b["rubyExplanation"] : null,
    referenceQuote: optNum(b["referenceQuote"]),
  });
  send(res, 201, { ticket: toWire(created) });
});

/**
 * Set a new Constitution version. APPEND-ONLY: this creates a new row and never
 * edits the old one, so a ticket that pinned an earlier version keeps meaning
 * what it meant when the user approved it.
 */
router.post("/me/trading-constitution", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (userId == null) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }

  const b = (req.body ?? {}) as Record<string, unknown>;
  // Validate with the SAME predicate the evaluator uses. A constitution that
  // stores but cannot be evaluated would refuse every trade later with
  // CONSTITUTION_MALFORMED, which reads as a bug rather than as bad input.
  const candidate = {
    ...b, constitutionId: `con_${randomUUID()}`, userId, version: 1,
  } as unknown as TradingConstitution;
  if (!constitutionIsWellFormed(candidate)) {
    res.status(400).json({ error: "CONSTITUTION_MALFORMED" });
    return;
  }

  const row = await tradingConstitutionRepo.appendConstitutionVersion({
    userId,
    createdBy: `user:${userId}`,
    values: {
      constitutionId: candidate.constitutionId,
      allowedBrokers: candidate.allowedBrokers,
      allowedAccountRefs: candidate.allowedAccountRefs,
      allowedInstruments: candidate.allowedInstruments,
      allowedMarketCategories: candidate.allowedMarketCategories,
      allowedSessionsUtc: candidate.allowedSessionsUtc,
      maxRiskPerTradeUsd: candidate.maxRiskPerTradeUsd,
      maxDailyLossUsd: candidate.maxDailyLossUsd,
      maxWeeklyLossUsd: candidate.maxWeeklyLossUsd,
      maxSimultaneousPositions: candidate.maxSimultaneousPositions,
      maxExposurePerSymbolUsd: candidate.maxExposurePerSymbolUsd,
      maxTradesPerDay: candidate.maxTradesPerDay,
      requireStopLoss: candidate.requireStopLoss,
      requireTakeProfit: candidate.requireTakeProfit,
      minStakeUsd: candidate.minStakeUsd,
      maxStakeUsd: candidate.maxStakeUsd,
      minMultiplier: candidate.minMultiplier,
      maxMultiplier: candidate.maxMultiplier,
      lossStreakCooldown: candidate.lossStreakCooldown,
      forbiddenInstruments: candidate.forbiddenInstruments,
      forbiddenConditions: candidate.forbiddenConditions,
      rubyAuthority: candidate.rubyAuthority,
    } as never,
  });
  send(res, 201, { constitutionId: row.constitutionId, version: row.version });
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
