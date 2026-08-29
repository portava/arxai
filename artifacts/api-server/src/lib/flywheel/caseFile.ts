// ── B0 — Case-file assembler (pure) ─────────────────────────────────────────
//
// A case file is the per-trade evidence record the rest of the flywheel reads:
// BEFORE (the draft's own plan), DURING (dispatch/fill), AFTER (exit result +
// the economic-posting journal ids). Every section carries a provenance stamp
// naming the seam it came from; every ABSENT section is listed in `missing`,
// never synthesized. The assembler only REARRANGES evidence that existing
// seams already recorded (mission_trade_drafts, arx command ids, broker
// tickets, economic_postings) — it derives nothing new and invents nothing.
//
// FLYWHEEL INVARIANT: pure — no IO, no clock (now is an input), no randomness,
// and nothing importable from any gate/floor/stop/dispatch path. Pinned by
// scripts/src/ci/check-flywheel-isolation.test.ts.

export type CaseFilePhase = "DRAFTED" | "DISPATCHED" | "CLOSED" | "RECONCILED";
export type CaseFileCompleteness = "FULL" | "PARTIAL";

/** The slice of a mission_trade_drafts row the assembler reads. */
export interface CaseDraftEvidence {
  draftId: string;
  missionId: number | null;
  userId: number;
  agentKey: string;
  symbol: string;
  direction: string;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  lot: number | null;
  riskAmount: number | null;
  expectedR: number | null;
  status: string;
  reason: string | null;
  edgeJson: unknown;
  resultJson: unknown;
  commandId: string | null;
  brokerTicket: string | null;
  pnl: number | null;
  rMultiple: number | null;
  exitReason: string | null;
  createdAt: Date | null;
  approvedAt: Date | null;
  closedAt: Date | null;
}

/** One economic posting's identity (evidence pointer, not a money value). */
export interface CasePostingEvidence {
  journalId: string;
  kind: string;
  source: string;
  ledger: string;
  valueUnknown: boolean;
  effectiveAt: Date;
}

export interface ProvenanceStamp {
  /** The seam the evidence came from — a table/seam name, never "derived". */
  source: string;
  recordedAt: string | null;
}

export interface AssembledCaseFile {
  caseId: string;
  userId: number;
  missionId: number | null;
  strategyId: string;
  symbol: string;
  direction: string;
  regimeLabel: string;
  phase: CaseFilePhase;
  before: Record<string, unknown>;
  during: Record<string, unknown>;
  after: Record<string, unknown>;
  provenance: Record<string, ProvenanceStamp>;
  completeness: CaseFileCompleteness;
  missing: string[];
  commandId: string | null;
  brokerTicket: string | null;
  ledger: string | null;
}

/**
 * PURE — pull an honest regime label out of recorded draft evidence. Looks for
 * a string `regime` (or `regimeLabel`) field in the given json blobs; anything
 * absent or non-string is "UNKNOWN" — a regime is never inferred here.
 */
export function deriveRegimeLabel(...blobs: unknown[]): string {
  for (const blob of blobs) {
    if (blob === null || typeof blob !== "object") continue;
    const rec = blob as Record<string, unknown>;
    for (const key of ["regime", "regimeLabel", "marketRegime"]) {
      const v = rec[key];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
  }
  return "UNKNOWN";
}

/**
 * PURE — assemble one case file from the seams' recorded evidence. The phase
 * is a high-water mark of what evidence EXISTS, not a claim about what
 * happened: a draft with a broker ticket but no close is DISPATCHED; a closed
 * draft with no postings yet is CLOSED (not RECONCILED).
 */
export function assembleCaseFile(
  draft: CaseDraftEvidence,
  postings: readonly CasePostingEvidence[],
): AssembledCaseFile {
  const missing: string[] = [];
  const provenance: Record<string, ProvenanceStamp> = {};

  // BEFORE — the draft's own plan, verbatim (the seam already validated it).
  const before: Record<string, unknown> = {
    entryPrice: draft.entryPrice,
    stopLoss: draft.stopLoss,
    takeProfit: draft.takeProfit,
    lot: draft.lot,
    riskAmount: draft.riskAmount,
    expectedR: draft.expectedR,
    reason: draft.reason,
    edgeJson: draft.edgeJson ?? null,
    draftStatus: draft.status,
  };
  provenance["before"] = {
    source: "mission_trade_drafts",
    recordedAt: draft.createdAt ? draft.createdAt.toISOString() : null,
  };
  if (draft.entryPrice === null || draft.stopLoss === null) {
    missing.push("BEFORE_PLAN_INCOMPLETE: draft has no full entry/stop pair");
  }

  // DURING — dispatch/fill evidence: only what the seams stamped on the draft.
  const dispatched = draft.commandId !== null || draft.brokerTicket !== null;
  const during: Record<string, unknown> = dispatched
    ? { commandId: draft.commandId, brokerTicket: draft.brokerTicket, approvedAt: draft.approvedAt ? draft.approvedAt.toISOString() : null }
    : {};
  if (dispatched) {
    provenance["during"] = {
      source: "mission_trade_drafts(commandId/brokerTicket ← live command pipeline seam)",
      recordedAt: draft.approvedAt ? draft.approvedAt.toISOString() : null,
    };
  } else {
    missing.push("DURING_ABSENT: no commandId/brokerTicket recorded (draft never dispatched)");
  }

  // AFTER — exit record + the posting journal ids (pointers, not re-derived
  // money: money truth stays in economic_postings, read by the RewardBuilder).
  const closed = draft.closedAt !== null;
  const journalIds = postings.map((p) => p.journalId);
  const after: Record<string, unknown> = closed
    ? {
        pnl: draft.pnl,
        rMultiple: draft.rMultiple,
        exitReason: draft.exitReason,
        closedAt: draft.closedAt ? draft.closedAt.toISOString() : null,
        resultJson: draft.resultJson ?? null,
        postingJournalIds: journalIds,
      }
    : {};
  if (closed) {
    provenance["after"] = {
      source: "mission_trade_drafts(exit record) + economic_postings(journal ids)",
      recordedAt: draft.closedAt ? draft.closedAt.toISOString() : null,
    };
  } else {
    missing.push("AFTER_ABSENT: no close recorded yet");
  }
  if (closed && journalIds.length === 0) {
    missing.push("POSTINGS_ABSENT: closed but no economic postings found for its commandId");
  }

  const phase: CaseFilePhase =
    closed && journalIds.length > 0 ? "RECONCILED"
    : closed ? "CLOSED"
    : dispatched ? "DISPATCHED"
    : "DRAFTED";

  // Ledger partition comes ONLY from the postings (the money truth); a case
  // with no postings has an honestly unknown ledger.
  const ledgers = new Set(postings.map((p) => p.ledger));
  const ledger = ledgers.size === 1 ? [...ledgers][0]! : null;
  if (ledgers.size > 1) {
    missing.push(`LEDGER_AMBIGUOUS: postings span ${[...ledgers].join(",")}`);
  }

  return {
    caseId: `cf_${draft.draftId}`,
    userId: draft.userId,
    missionId: draft.missionId,
    strategyId: draft.agentKey,
    symbol: draft.symbol,
    direction: draft.direction,
    regimeLabel: deriveRegimeLabel(draft.edgeJson, draft.resultJson),
    phase,
    before,
    during,
    after,
    provenance,
    completeness: missing.length === 0 ? "FULL" : "PARTIAL",
    missing,
    commandId: draft.commandId,
    brokerTicket: draft.brokerTicket,
    ledger,
  };
}
