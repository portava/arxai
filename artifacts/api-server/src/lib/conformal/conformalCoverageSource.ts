// ── Capability #4 — the coverage report's evidence source (IO only) ─────────
//
// Reads the labeled advisory predictions the system has actually journaled and
// hands them to the pure report engine
// (@workspace/domain/confidence-gate `buildConformalCoverageReport`).
//
// SAFETY (inviolable):
//   * READ-ONLY. SELECTs only. This file contains no INSERT/UPDATE/DELETE, no
//     env write, and no call into the conformal AUTHORITY engine (the veto)
//     or into the flag reader's log-state reset.
//     Producing the report can never arm ARX_CONFORMAL_GATE_ENABLED — the
//     press stays the owner's. (Pinned by a source assertion in the proof
//     suite, so a later edit that adds a write fails red.)
//   * A FAILED READ IS A TYPED NULL WITH A REASON, never an empty array. An
//     empty array means "we read the feed and it holds nothing"; null means
//     "we could not look". Reporting the second as the first would let an
//     outage read as a clean zero.
//   * NO SUBSTITUTE FEED. If the conformal journal is empty, the report says
//     so. It never falls back to shadow-prediction outcomes, pattern outcomes
//     or fill records: coverage measured over a different prediction stream is
//     not evidence about this gate.

import { desc, eq } from "drizzle-orm";
import { db, auditEventsTable } from "@workspace/db";
import {
  CONFORMAL_ADVISORY_PREDICTION_EVENT_TYPE,
  buildConformalCoverageReport,
  summarizeJournaledConformalPrediction,
  type ConformalCoverageReport,
  type LabeledConformalRecord,
} from "@workspace/domain/confidence-gate";
import { conformalGateBootStatus } from "./conformalGateFlag.js";

/** Newest journaled advisory predictions examined per report. */
export const CONFORMAL_COVERAGE_EVIDENCE_WINDOW = 5000;

/**
 * STATIC, SOURCE-PINNED FACT: is there a production call site that appends to
 * the CONFORMAL_ADVISORY_PREDICTION feed?
 *
 * Today: NO. `applyConformalAuthority` has no production call site (the
 * confidence gate has no live assembler in the api-server), and nothing calls
 * lib/validation's `conformalGate` / `calibrateConformal` either. So the feed
 * has no writer and its sample cannot grow on its own.
 *
 * This constant is not a runtime guess — the proof suite greps the tree and
 * fails RED if a writer appears, forcing this to be updated with it. The grep
 * is deliberately WIDER than this one event-type string, because the string is
 * a contract this report invented: a future writer could journal coverage
 * evidence under a different name and leave this report blind while it kept
 * printing "no writer, sample 0". So the suite also pins that
 * `calibrateConformal` / `validateCoverage` / `conformalGate` still have no
 * production caller (a real coverage writer must compute intervals through
 * one of them) and that no rival CONFORMAL-named event-type literal exists.
 */
export const CONFORMAL_ADVISORY_FEED_WRITER_WIRED = false;

/**
 * STATIC, SOURCE-PINNED FACT: does any production call site consume
 * `applyConformalAuthority`, i.e. would pressing the flag change behavior?
 *
 * Today: NO — the same blocker, stated separately because they are different
 * facts. Pinned by the same proof suite.
 */
export const CONFORMAL_AUTHORITY_CALL_SITE_WIRED = false;

export const CONFORMAL_ADVISORY_FEED_WRITER_NOTE =
  "CONFORMAL_ADVISORY_PREDICTION is a feed CONTRACT this report declares — no writer has ever emitted it. " +
  "applyConformalAuthority is never invoked (runConfidenceGate has no live assembler), and lib/validation's " +
  "conformalGate/calibrateConformal/validateCoverage have no caller outside tests. A sample of 0 here therefore " +
  "means 'no writer', not 'quiet period'. And this report reads ONLY this event type with the payload contract " +
  "{predicted, actual, predictedAt}: coverage evidence journaled under any other name or shape would be invisible " +
  "here, so a writer MUST be built against the contract in docs/CONFORMAL_GATE_AUTHORITY.md " +
  "(\"The feed contract\"). See also \"Integration status\" there.";

type LoadedRecords =
  | { ok: true; records: LabeledConformalRecord[]; rowsSeen: number; unreadableRows: number }
  | { ok: false; reason: string };

/** Read the journaled labeled predictions. Never throws; a failure is typed. */
export async function loadConformalAdvisoryRecords(): Promise<LoadedRecords> {
  try {
    const rows = await db
      .select({ payload: auditEventsTable.payload })
      .from(auditEventsTable)
      .where(eq(auditEventsTable.eventType, CONFORMAL_ADVISORY_PREDICTION_EVENT_TYPE))
      .orderBy(desc(auditEventsTable.id))
      .limit(CONFORMAL_COVERAGE_EVIDENCE_WINDOW);
    const records: LabeledConformalRecord[] = [];
    let unreadable = 0;
    for (const row of rows) {
      const rec = summarizeJournaledConformalPrediction(row.payload);
      if (rec) records.push(rec);
      else unreadable += 1;
    }
    return { ok: true, records, rowsSeen: rows.length, unreadableRows: unreadable };
  } catch (err) {
    return {
      ok: false,
      reason: `conformal advisory journal read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Build the coverage report the owner looks at before arming the flag.
 * Read-only; the returned object is data, consumed by no authority path.
 */
export async function buildConformalCoverageReportFromJournal(
  nowMs = Date.now(),
): Promise<ConformalCoverageReport> {
  const loaded = await loadConformalAdvisoryRecords();
  const boot = conformalGateBootStatus();
  return buildConformalCoverageReport({
    records: loaded.ok ? loaded.records : null,
    sourceError: loaded.ok ? null : loaded.reason,
    unreadableRows: loaded.ok ? loaded.unreadableRows : 0,
    writerWired: CONFORMAL_ADVISORY_FEED_WRITER_WIRED,
    writerNote: CONFORMAL_ADVISORY_FEED_WRITER_NOTE,
    flagPressed: boot.pressed,
    flagWired: CONFORMAL_AUTHORITY_CALL_SITE_WIRED,
    nowIso: new Date(nowMs).toISOString(),
  });
}
