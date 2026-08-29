// Economic account taxonomy (#30) — the chart of accounts for the economic
// truth spine.
//
// SCOPE, stated honestly: this is the SPINE taxonomy for the postings ARX can
// make TODAY at the seams that exist (fill confirmation, close reconciliation,
// guided demo settlement) — not a full chart of accounts for an accounting
// product. Accounts are added when a real posting needs them, never
// speculatively.
//
// SIGN CONVENTION (single, repo-wide): every journal's legs sum to ZERO.
// A positive amount INCREASES the account's balance; a negative amount
// decreases it. There is no separate debit/credit column — the sign IS the
// side, which makes the balance invariant a one-line check:
// sum(amount) === 0 per journal, and sum(all postings) === 0 always.

/** The two ledger partitions. DEMO money and LIVE money never mix. */
export const LEDGER_PARTITIONS = ["LIVE", "DEMO"] as const;
export type LedgerPartition = (typeof LEDGER_PARTITIONS)[number];

export function isLedgerPartition(v: unknown): v is LedgerPartition {
  return typeof v === "string" && (LEDGER_PARTITIONS as readonly string[]).includes(v);
}

/**
 * Core accounts.
 *
 *   BROKER_CASH      — cash at the broker (asset). The reconciliation pass
 *                      compares THIS account's balance against the broker's
 *                      reported account balance.
 *   OPEN_POSITIONS   — capital parked in open positions/contracts (asset).
 *                      A Deriv stake moves BROKER_CASH → OPEN_POSITIONS at
 *                      buy time; MT5 margin trades don't move cash at open.
 *   REALIZED_PNL     — realized profit and loss (income; profit posts
 *                      NEGATIVE here so the matching BROKER_CASH leg is
 *                      positive and the journal sums to zero).
 *   FEES_EXPENSE     — commissions and fees (expense).
 *   FUNDING_EXPENSE  — funding / swap / overnight financing (expense; a
 *                      positive swap credit posts negative here).
 *   UNKNOWN_SUSPENSE — the honesty account: the counter-leg for postings
 *                      whose true amount is NOT KNOWN yet (valueUnknown
 *                      rows). Never carries a claimed value.
 */
export const ECONOMIC_ACCOUNTS = [
  "BROKER_CASH",
  "OPEN_POSITIONS",
  "REALIZED_PNL",
  "FEES_EXPENSE",
  "FUNDING_EXPENSE",
  "UNKNOWN_SUSPENSE",
] as const;

export type EconomicAccount = (typeof ECONOMIC_ACCOUNTS)[number];

export function isEconomicAccount(v: unknown): v is EconomicAccount {
  return typeof v === "string" && (ECONOMIC_ACCOUNTS as readonly string[]).includes(v);
}

/**
 * Per-strategy attribution is carried in the posting's OWN `strategyId`
 * column, NOT by minting new account strings — so the account taxonomy stays
 * closed (a typo cannot invent an account) while any account balance can
 * still be grouped by strategy. This helper only validates the id shape.
 */
export function normalizeStrategyId(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (s === "") return null;
  if (s.length > 128) return s.slice(0, 128);
  return s;
}
