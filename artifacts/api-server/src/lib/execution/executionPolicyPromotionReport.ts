// ── Capability #27 — the promotion report's evidence source (IO only) ───────
//
// Reads the shadow chooser's journal and the promotion ladder row, and hands
// both to the pure report engine (@workspace/domain/execution-policy
// `buildExecutionPolicyPromotionReport`).
//
// SAFETY (inviolable):
//   * READ-ONLY. SELECTs only. Deliberately does NOT call
//     `refreshPromotionEvidence` — that function WRITES (it keeps the ladder
//     row current and can move SHADOW ↔ PRESS_UNLOCKED). A report must not
//     change the thing it reports on, and no report path may unlock a press.
//     This file contains no INSERT/UPDATE/DELETE and never calls the enable or
//     revert press seams. (Pinned by a source assertion in the proof suite,
//     which names those functions so a later edit that calls one fails red.)
//   * A FAILED READ IS A TYPED NULL WITH A REASON, never an empty evidence
//     object. A missing table is reported as such, never as "0 recommendations".

import { desc, eq } from "drizzle-orm";
import { db, auditEventsTable } from "@workspace/db";
import {
  EXECUTION_POLICY_SHADOW_JOURNAL_FEED,
  buildExecutionPolicyPromotionReport,
  evaluatePromotionEvidence,
  isPromotionStatus,
  summarizeJournaledRecommendation,
  type ExecutionPolicyPromotionReport,
  type PromotionStatus,
  type RecommendationSummary,
} from "@workspace/domain/execution-policy";
import { windowFromStamps, type EvidenceWindow } from "@workspace/domain/evidence-gate";
import { PROMOTION_EVIDENCE_WINDOW, readPromotionState } from "./executionPolicyPromotion.js";

/**
 * STATIC, SOURCE-PINNED FACT: is there a production call site that appends to
 * the EXECUTION_POLICY_SHADOW_RECOMMENDATION journal?
 *
 * Today: NO. `recordExecutionPolicyShadowRecommendation`
 * (lib/execution/executionPolicyShadow.ts) is its only writer and has no
 * caller outside tests. So an empty journal means "nothing runs the shadow
 * chooser", not "few trades this week" — a distinction an owner reading a
 * bare 0 cannot otherwise make.
 *
 * Not a runtime guess: the proof suite greps the tree for a caller and fails
 * RED if one appears, forcing this constant to be updated with it.
 */
export const SHADOW_JOURNAL_WRITER_WIRED = false;
export const SHADOW_JOURNAL_WRITER_NOTE =
  "No production call site invokes recordExecutionPolicyShadowRecommendation " +
  "(artifacts/api-server/src/lib/execution/executionPolicyShadow.ts), so nothing appends to the " +
  "EXECUTION_POLICY_SHADOW_RECOMMENDATION journal. A sample of 0 here means 'no writer', not 'quiet period'. " +
  "Scheduling that chooser is a separate reviewed change.";

type JournalRead =
  | {
      ok: true;
      summaries: RecommendationSummary[];
      rowsSeen: number;
      unreadableRows: number;
      window: EvidenceWindow | null;
    }
  | { ok: false; reason: string };

/** Read the shadow journal, including the chronological span. Never throws. */
async function readShadowJournal(): Promise<JournalRead> {
  try {
    const rows = await db
      .select({
        payload: auditEventsTable.payload,
        timestamp: auditEventsTable.timestamp,
        createdAt: auditEventsTable.createdAt,
      })
      .from(auditEventsTable)
      .where(eq(auditEventsTable.eventType, EXECUTION_POLICY_SHADOW_JOURNAL_FEED))
      .orderBy(desc(auditEventsTable.id))
      .limit(PROMOTION_EVIDENCE_WINDOW);
    const summaries: RecommendationSummary[] = [];
    const stamps: number[] = [];
    let unreadable = 0;
    for (const row of rows) {
      const s = summarizeJournaledRecommendation(row.payload);
      if (s) summaries.push(s);
      else unreadable += 1;
      // Prefer the event's own timestamp; fall back to the DB write time.
      // An unparseable stamp is dropped, never replaced with "now".
      const parsed = Date.parse(row.timestamp ?? "");
      if (Number.isFinite(parsed)) stamps.push(parsed);
      else if (row.createdAt instanceof Date) stamps.push(row.createdAt.getTime());
    }
    return {
      ok: true,
      summaries,
      rowsSeen: rows.length,
      unreadableRows: unreadable,
      window: windowFromStamps(stamps),
    };
  } catch (err) {
    return {
      ok: false,
      reason: `shadow-recommendation journal read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Build the promotion report the owner looks at before pressing ENABLE.
 * Read-only: it never refreshes, unlocks, enables or reverts anything.
 */
export async function buildPromotionReportFromJournal(
  nowMs = Date.now(),
): Promise<ExecutionPolicyPromotionReport> {
  const journal = await readShadowJournal();
  const state = await readPromotionState();
  // Mirrors the private `rowStatus` reading in executionPolicyPromotion.ts:
  // an absent row or an unreadable status is SHADOW, the least-authority
  // reading. A failed READ is null — "could not look" is not "shadow".
  const currentStatus: PromotionStatus | null = !state.ok
    ? null
    : state.row && isPromotionStatus(state.row.status)
      ? state.row.status
      : "SHADOW";
  return buildExecutionPolicyPromotionReport({
    evidence: journal.ok ? evaluatePromotionEvidence(journal.summaries) : null,
    sourceError: journal.ok ? null : journal.reason,
    journalRowsSeen: journal.ok ? journal.rowsSeen : null,
    unreadableRows: journal.ok ? journal.unreadableRows : 0,
    writerWired: SHADOW_JOURNAL_WRITER_WIRED,
    writerNote: SHADOW_JOURNAL_WRITER_NOTE,
    currentStatus,
    statusReadError: state.ok ? null : state.reason,
    window: journal.ok ? journal.window : null,
    nowIso: new Date(nowMs).toISOString(),
  });
}
