// Read-only coverage of the recorded agent book. Completeness is not broker
// verification; no balance, realized outcome or execution authority is written.
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  db,
  selfTradeAgentsTable as agents,
  selfTradeAgentLedgerTable as ledgers,
  selfTradeAgentExecutionsTable as executions,
  selfTradeLedgerEntriesTable as entries,
} from "@workspace/db";

export interface AccountingCoverage {
  status: "RECORDED" | "INCOMPLETE" | "UNAVAILABLE";
  asOf: string;
  dayStart: string;
  closedTrades: number;
  recordedTrades: number;
  unknownTrades: number;
  unresolvedAccounting: number;
  unknownCloseTime: number;
  missingLedgers: number;
  unpostedTrades: number;
  unreconciledLedgers: number;
  unmatchedPostings: number;
  recordedRealizedPnl: number | null;
  recordedAvailableFunds: number | null;
  dailyRecordedPnl: number | null;
  dailyLossUsed: number | null;
  notes: string[];
}

export interface AccountingRow {
  agentId: number;
  allocatedFunds: number | null;
  availableFunds: number | null;
  realizedPnl: number | null;
  openPnl: number | null;
  closedTrades: number;
  recordedTrades: number;
  unresolvedAccounting: number;
  unknownCloseTime: number;
  dailyRecordedPnl: number;
  dailyUnknownTrades: number;
  unpostedTrades: number;
  postedRealizedPnl: number;
  invalidPostingCurrencies: number;
  unmatchedPostings: number;
}

const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
export function accountingDayStart(now: Date) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** One grouped statement reads ledger and execution coverage from the same DB
 * snapshot. It returns one row per visible agent, using existing agent indexes. */
export async function readAccountingRows(
  ids: number[],
  ownerWhere?: SQL,
  now = new Date(),
): Promise<AccountingRow[]> {
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid accounting observation time");
  if (!ids.length) return [];
  const postings = db
    .select({
      agentId: entries.agentId,
      executionId: entries.refId,
      receiptCount: sql<number>`count(*)`.as("receipt_count"),
      amount: sql<number>`sum(${entries.amount})`.as("receipt_amount"),
      usd: sql<boolean>`bool_and(${entries.currency} = 'USD')`.as(
        "receipts_usd",
      ),
    })
    .from(entries)
    .where(
      and(
        inArray(entries.agentId, ids),
        eq(entries.entryType, "REALIZED_PNL"),
        eq(entries.refType, "EXECUTION"),
      ),
    )
    .groupBy(entries.agentId, entries.refId)
    .as("accounting_postings");
  const closed = sql`${executions.status} = 'CLOSED'`;
  const held = sql`coalesce(${executions.managementState} ? 'closeAccounting', false)`;
  const finitePnl = sql`${executions.realizedPnl} > '-Infinity'::float8 AND ${executions.realizedPnl} < 'Infinity'::float8`;
  const known = sql`${closed} AND (${finitePnl}) AND NOT ${held}`;
  const validClose = sql`${executions.closedAt} > '-infinity'::timestamptz AND ${executions.closedAt} <= ${now}`;
  const today = sql`${executions.closedAt} >= ${accountingDayStart(now)} AND ${executions.closedAt} <= ${now}`;
  // Mirrors the producer's cent rounding, including JS's negative half-tie
  // convention. A small binary-float tolerance is far below one cent.
  const expectedPosted = sql`floor((${executions.realizedPnl} + ${Number.EPSILON}) * 100 + 0.5) / 100`;
  const matchedPosting = sql`${postings.receiptCount} = 1 AND ${postings.usd} AND abs(${postings.amount} - (${expectedPosted})) < 0.00000001`;
  const totals = db
    .select({
      agentId: entries.agentId,
      amount: sql<number>`sum(${entries.amount})`.as("posted_pnl"),
      unmatched:
        sql<number>`count(*) FILTER (WHERE NOT coalesce((${known} AND ${matchedPosting}), false))`.as(
          "unmatched_postings",
        ),
      invalidCurrency:
        sql<number>`count(*) FILTER (WHERE ${entries.currency} <> 'USD')`.as(
          "invalid_currency",
        ),
    })
    .from(entries)
    .leftJoin(
      executions,
      and(
        eq(executions.agentId, entries.agentId),
        eq(executions.id, entries.refId),
        eq(entries.refType, "EXECUTION"),
      ),
    )
    .leftJoin(
      postings,
      and(
        eq(postings.agentId, executions.agentId),
        eq(postings.executionId, executions.id),
      ),
    )
    .where(
      and(inArray(entries.agentId, ids), eq(entries.entryType, "REALIZED_PNL")),
    )
    .groupBy(entries.agentId)
    .as("accounting_posted_totals");
  const count = (predicate: SQL) =>
    sql<number>`count(${executions.id}) FILTER (WHERE ${predicate})`.mapWith(
      Number,
    );
  return db
    .select({
      agentId: agents.id,
      allocatedFunds: ledgers.allocatedFunds,
      availableFunds: ledgers.availableFunds,
      realizedPnl: ledgers.realizedPnl,
      openPnl: ledgers.openPnl,
      closedTrades: count(closed),
      recordedTrades: count(known),
      unresolvedAccounting: count(held),
      unknownCloseTime: count(
        sql`${closed} AND NOT coalesce((${validClose}), false)`,
      ),
      dailyRecordedPnl:
        sql<number>`coalesce(sum(${executions.realizedPnl}) FILTER (WHERE ${known} AND ${today}), 0)`.mapWith(
          Number,
        ),
      unpostedTrades: count(
        sql`${known} AND NOT coalesce((${matchedPosting}), false)`,
      ),
      postedRealizedPnl: sql<number>`coalesce(${totals.amount}, 0)`.mapWith(
        Number,
      ),
      unmatchedPostings: sql<number>`coalesce(${totals.unmatched}, 0)`.mapWith(
        Number,
      ),
      invalidPostingCurrencies:
        sql<number>`coalesce(${totals.invalidCurrency}, 0)`.mapWith(Number),
      dailyUnknownTrades: count(
        sql`${closed} AND ${today} AND NOT coalesce((${known}), false)`,
      ),
    })
    .from(agents)
    .leftJoin(ledgers, eq(ledgers.agentId, agents.id))
    .leftJoin(executions, eq(executions.agentId, agents.id))
    .leftJoin(
      postings,
      and(
        eq(postings.agentId, executions.agentId),
        eq(postings.executionId, executions.id),
      ),
    )
    .leftJoin(totals, eq(totals.agentId, agents.id))
    .where(and(inArray(agents.id, ids), ownerWhere))
    .groupBy(
      agents.id,
      ledgers.allocatedFunds,
      ledgers.availableFunds,
      ledgers.realizedPnl,
      ledgers.openPnl,
      totals.amount,
      totals.invalidCurrency,
      totals.unmatched,
    );
}

export function projectAccounting(
  row: AccountingRow | undefined,
  now = new Date(),
): AccountingCoverage {
  const ledgerValid =
    !!row &&
    [
      row.allocatedFunds,
      row.availableFunds,
      row.realizedPnl,
      row.openPnl,
      row.dailyRecordedPnl,
    ].every(finite);
  const unknownTrades = row
    ? Math.max(0, row.closedTrades - row.recordedTrades)
    : 0;
  const ledgerReconciled =
    !!row &&
    finite(row.postedRealizedPnl) &&
    finite(row.realizedPnl) &&
    Math.abs(row.postedRealizedPnl - row.realizedPnl) < 0.00000001 &&
    row.invalidPostingCurrencies === 0;
  const incomplete =
    !ledgerReconciled ||
    (row?.unmatchedPostings ?? 0) > 0 ||
    (row?.unpostedTrades ?? 0) > 0 ||
    unknownTrades > 0 ||
    (row?.unresolvedAccounting ?? 0) > 0 ||
    (row?.unknownCloseTime ?? 0) > 0;
  const status = !ledgerValid
    ? "UNAVAILABLE"
    : incomplete
      ? "INCOMPLETE"
      : "RECORDED";
  const dailyRecordedPnl = finite(row?.dailyRecordedPnl)
    ? row.dailyRecordedPnl
    : null;
  const notes = [
    "Recorded book values; coverage does not verify broker history, fees or a current account balance.",
  ];
  if (!ledgerValid)
    notes.push(
      "The recorded ledger is missing or invalid; complete totals are unavailable.",
    );
  if (row?.unpostedTrades)
    notes.push(
      `${row.unpostedTrades} recorded close${row.unpostedTrades === 1 ? " lacks" : "s lack"} one matching ledger posting.`,
    );
  if (row?.unmatchedPostings)
    notes.push(
      `${row.unmatchedPostings} realized posting${row.unmatchedPostings === 1 ? " does" : "s do"} not match one usable closed execution for this agent.`,
    );
  if (row && !ledgerReconciled)
    notes.push(
      "The ledger realized subtotal does not reconcile to usable recorded postings.",
    );
  if (unknownTrades)
    notes.push(
      `${unknownTrades} closed trade${unknownTrades === 1 ? " has" : "s have"} no usable recorded profit or loss.`,
    );
  if (row?.unresolvedAccounting)
    notes.push(
      `${row.unresolvedAccounting} accounting hold${row.unresolvedAccounting === 1 ? " remains" : "s remain"} unresolved. Recorded capital is not available-risk evidence.`,
    );
  if (row?.unknownCloseTime)
    notes.push(
      "Some close times are missing, future or invalid; daily loss is unavailable.",
    );
  return {
    status,
    asOf: now.toISOString(),
    dayStart: accountingDayStart(now).toISOString(),
    closedTrades: row?.closedTrades ?? 0,
    recordedTrades: row?.recordedTrades ?? 0,
    unknownTrades,
    unresolvedAccounting: row?.unresolvedAccounting ?? 0,
    unknownCloseTime: row?.unknownCloseTime ?? 0,
    missingLedgers: ledgerValid ? 0 : 1,
    unpostedTrades: row?.unpostedTrades ?? 0,
    unreconciledLedgers: row && !ledgerReconciled ? 1 : 0,
    unmatchedPostings: row?.unmatchedPostings ?? 0,
    recordedRealizedPnl: finite(row?.realizedPnl) ? row.realizedPnl : null,
    recordedAvailableFunds: finite(row?.availableFunds)
      ? row.availableFunds
      : null,
    dailyRecordedPnl,
    dailyLossUsed:
      status === "RECORDED" &&
      row?.dailyUnknownTrades === 0 &&
      dailyRecordedPnl != null
        ? Math.max(0, -dailyRecordedPnl)
        : null,
    notes,
  };
}

export function combineAccounting(
  items: AccountingCoverage[],
  now = new Date(),
): AccountingCoverage {
  const sum = (
    key:
      | "closedTrades"
      | "recordedTrades"
      | "unknownTrades"
      | "unresolvedAccounting"
      | "unknownCloseTime"
      | "missingLedgers"
      | "unpostedTrades"
      | "unreconciledLedgers"
      | "unmatchedPostings",
  ) => items.reduce((n, item) => n + item[key], 0);
  const subtotal = (
    key: "recordedRealizedPnl" | "recordedAvailableFunds" | "dailyRecordedPnl",
  ) => {
    const values = items.map((item) => item[key]).filter(finite);
    const total =
      values.length || !items.length ? values.reduce((a, b) => a + b, 0) : null;
    return finite(total) ? total : null;
  };
  const daily = subtotal("dailyRecordedPnl");
  const realized = subtotal("recordedRealizedPnl");
  const available = subtotal("recordedAvailableFunds");
  const invalidTotal = daily == null || realized == null || available == null;
  const status =
    invalidTotal || items.some((x) => x.status === "UNAVAILABLE")
      ? "UNAVAILABLE"
      : items.some((x) => x.status === "INCOMPLETE")
        ? "INCOMPLETE"
        : "RECORDED";
  const notes = [...new Set(items.flatMap((x) => x.notes))];
  if (invalidTotal)
    notes.push(
      "Some aggregate recorded amounts are unavailable or outside the supported numeric range.",
    );
  return {
    status,
    asOf: now.toISOString(),
    dayStart: accountingDayStart(now).toISOString(),
    closedTrades: sum("closedTrades"),
    recordedTrades: sum("recordedTrades"),
    unknownTrades: sum("unknownTrades"),
    unresolvedAccounting: sum("unresolvedAccounting"),
    unknownCloseTime: sum("unknownCloseTime"),
    missingLedgers: sum("missingLedgers"),
    unpostedTrades: sum("unpostedTrades"),
    unreconciledLedgers: sum("unreconciledLedgers"),
    unmatchedPostings: sum("unmatchedPostings"),
    recordedRealizedPnl: realized,
    recordedAvailableFunds: available,
    dailyRecordedPnl: daily,
    dailyLossUsed:
      status === "RECORDED" &&
      items.every((x) => x.dailyLossUsed != null) &&
      daily != null
        ? Math.max(0, -daily)
        : null,
    notes,
  };
}
