// Economic posting writer — persists balanced journals at the EXISTING
// fill-confirmation / close-reconciliation / guided-settlement seams.
//
// CONTRACT (same as recordExecutionEvent's, deliberately):
//   - BEST-EFFORT EVIDENCE. A posting write must NEVER throw into, fail, or
//     delay result settlement or dispatch. Every failure path warns loudly
//     and returns { ok: false } — the trade outcome is already committed and
//     is not this module's to disturb.
//   - BALANCED OR REFUSED. The journal is re-validated here (buildJournal
//     already validated it, but this is the last line before persistence);
//     an imbalanced journal is REFUSED and logged, never "fixed".
//   - APPEND-ONLY. Inserts only. Corrections arrive as new reverse/repost
//     journals built by @workspace/accounting — there is no update path in
//     this module and check-vault-mutations forbids one anywhere.
//   - IDEMPOTENT-ish: journal ids are deterministic per seam event
//     (ej_<commandId>_close_pnl etc.), and unique(journal_id, leg_index)
//     turns a duplicate EA callback's re-post into a unique violation,
//     which is swallowed as "already recorded" — a duplicate result can
//     never double-post money.
//   - NOTHING FABRICATED: unknown amounts arrive as valueUnknown legs and
//     are stored as flagged zeros (the flag IS the honesty).

import { db, economicPostingsTable } from "@workspace/db";
import type { EconomicJournal } from "@workspace/accounting";
import { checkBalanceInvariant } from "@workspace/accounting";
import { logger } from "../logger.js";

export interface JournalWriteResult {
  ok: boolean;
  journalId: string;
  reason?: string;
}

/**
 * Persist one balanced journal (all legs, one insert). Never throws.
 */
export async function writeEconomicJournal(journal: EconomicJournal): Promise<JournalWriteResult> {
  try {
    // Last-line balance check against the exact rows about to be written.
    const rows = journal.legs.map((leg, i) => ({
      journalId: journal.journalId,
      legIndex: i,
      userId: journal.userId,
      ledger: journal.ledger,
      account: leg.account,
      strategyId: journal.strategyId,
      amountMinor: leg.amount.minor,
      currency: leg.amount.currency,
      scale: leg.amount.scale,
      valueUnknown: leg.valueUnknown,
      kind: journal.kind,
      source: journal.source,
      effectiveAt: journal.effectiveAt,
      knownAt: journal.knownAt,
      commandId: journal.commandId,
      brokerTicket: journal.brokerTicket,
      reversesJournalId: journal.reversesJournalId,
      metadata: journal.metadata,
    }));
    const balance = checkBalanceInvariant(rows);
    if (!balance.balanced) {
      logger.error({
        event: "ECONOMIC_JOURNAL_REFUSED_IMBALANCED",
        journalId: journal.journalId,
        totals: Object.fromEntries(Object.entries(balance.totals).map(([k, v]) => [k, v.toString()])),
      }, "economic journal REFUSED — legs do not sum to zero; nothing written, nothing plugged");
      return { ok: false, journalId: journal.journalId, reason: "IMBALANCED" };
    }
    await db.insert(economicPostingsTable).values(rows);
    return { ok: true, journalId: journal.journalId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/economic_postings_journal_leg_uq|duplicate key/.test(msg)) {
      // Duplicate seam event (EA retry / CAS-race duplicate) — the journal is
      // already on the ledger; re-posting it would double-count money.
      return { ok: true, journalId: journal.journalId, reason: "ALREADY_RECORDED" };
    }
    logger.warn({
      event: "ECONOMIC_JOURNAL_WRITE_FAILED",
      journalId: journal.journalId,
      error: msg,
    }, "economic journal write failed — evidence not recorded (trade outcome unaffected)");
    return { ok: false, journalId: journal.journalId, reason: msg };
  }
}

/** Persist several journals in order, best-effort each. */
export async function writeEconomicJournals(journals: readonly EconomicJournal[]): Promise<JournalWriteResult[]> {
  const results: JournalWriteResult[] = [];
  for (const j of journals) results.push(await writeEconomicJournal(j));
  return results;
}
