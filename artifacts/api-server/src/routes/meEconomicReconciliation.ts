// The human-readable end of the economic reconciliation spine (#29/#30/#31).
//
// economicReconciliationWorker compares the posting ledger's BROKER_CASH
// balance against the broker's reported balance and APPENDS a verdict to
// economic_discrepancies — including a CRITICAL "your ledger disagrees with
// the broker" DISCREPANCY. Before this route existed that verdict reached a
// table and a log line and NO human: every money surface kept rendering
// confident dollar figures with no way to learn the basis was disputed.
//
//   GET /api/me/economic-reconciliation  — the caller's own latest verdict
//
// HONESTY (inviolable):
//   * Per-user scoped on req.authUser.id. No cross-user read exists here.
//   * A missing run is `state: "NEVER_RUN"` with a reason — never a
//     reassuring "MATCHED", never an implied clean bill of health.
//   * An unreadable ledger is a typed 503 (`DISCREPANCY_LEDGER_UNREADABLE`),
//     never an empty-but-confident 200.
//   * Read-only. This route holds no correction seam: resolving a
//     discrepancy is a human-authored correction journal, exactly as the
//     worker's contract says.

import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, economicDiscrepanciesTable } from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

/** The ledger this surface reports on. Only real money is reconciled. */
const LEDGER = "LIVE";

/**
 * The four states a money surface may honestly display, derived ONLY from a
 * persisted verdict. Exported for the offline test lane.
 *
 *   NEVER_RUN   — no comparison has ever been journaled for this user.
 *   DISPUTED    — the last verdict was DISCREPANCY: the broker balance and the
 *                 posting ledger disagree. Figures downstream are NOT
 *                 broker-reconciled.
 *   UNVERIFIED  — the last verdict was UNKNOWN or BASELINE_ESTABLISHED: the
 *                 comparison could not be made (stale/missing broker figure,
 *                 mixed currencies) or only established a starting point.
 *   RECONCILED  — the last verdict was MATCHED.
 *
 * An unrecognised verdict maps to UNVERIFIED, never to RECONCILED: an unknown
 * word may not be promoted into a claim of agreement.
 */
export type LedgerBasisState = "NEVER_RUN" | "DISPUTED" | "UNVERIFIED" | "RECONCILED";

export function basisStateForVerdict(verdict: string | null | undefined): LedgerBasisState {
  if (verdict == null) return "NEVER_RUN";
  switch (verdict) {
    case "MATCHED": return "RECONCILED";
    case "DISCREPANCY": return "DISPUTED";
    default: return "UNVERIFIED";
  }
}

/** PURE — the one-line basis sentence a money surface may display. */
export function basisHeadline(state: LedgerBasisState): string {
  switch (state) {
    case "RECONCILED":
      return "Your posting ledger matched the broker's reported balance at the last check.";
    case "DISPUTED":
      return "Your posting ledger DISAGREES with the broker's reported balance. Money figures shown elsewhere in ARX are not broker-reconciled until this is resolved.";
    case "UNVERIFIED":
      return "The last reconciliation could not compare your ledger to the broker. Money figures shown elsewhere in ARX are unverified against the broker.";
    case "NEVER_RUN":
      return "No ledger-vs-broker reconciliation has run for your account yet. Money figures shown elsewhere in ARX have not been checked against the broker.";
  }
}

router.get("/me/economic-reconciliation", requireUser, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(economicDiscrepanciesTable)
      .where(and(
        eq(economicDiscrepanciesTable.userId, req.authUser!.id),
        eq(economicDiscrepanciesTable.ledger, LEDGER),
      ))
      .orderBy(desc(economicDiscrepanciesTable.id))
      .limit(20);

    const latest = rows[0] ?? null;
    const state = basisStateForVerdict(latest?.verdict);

    res.json({
      ledger: LEDGER,
      state,
      headline: basisHeadline(state),
      latest: latest == null ? null : {
        verdict: latest.verdict,
        reason: latest.reason,
        differenceMinor: latest.differenceMinor?.toString() ?? null,
        brokerBalanceMinor: latest.brokerBalanceMinor?.toString() ?? null,
        ledgerCashMinor: latest.ledgerCashMinor.toString(),
        currency: latest.currency,
        scale: latest.scale,
        brokerSource: latest.brokerSource,
        truthWinner: latest.truthWinner,
        trigger: latest.trigger,
        observedAt: latest.observedAt.toISOString(),
      },
      history: rows.map((r) => ({
        verdict: r.verdict,
        reason: r.reason,
        differenceMinor: r.differenceMinor?.toString() ?? null,
        currency: r.currency,
        scale: r.scale,
        trigger: r.trigger,
        observedAt: r.observedAt.toISOString(),
      })),
      note: "Surfacing only. ARX never auto-adjusts a ledger to make it agree with the broker; a disagreement is resolved by a human-authored correction.",
    });
  } catch (err) {
    req.log.error(err);
    res.status(503).json({ error: "DISCREPANCY_LEDGER_UNREADABLE" });
  }
});

export default router;
