// Broker-statement reconciliation worker (#29/#30/#31) — daily + on demand.
//
// WHAT IT DOES, and all it does: for every user with LIVE economic postings,
// compare the posting ledger's BROKER_CASH balance (baseline + sum of
// postings) against the broker's reported account balance (the EXISTING
// account snapshot ingest — mt5_connection.account_balance, stamped by the
// EA's heartbeat/sync-account). The verdict is decided by the PURE
// @workspace/accounting comparison, ranked by the #31 truth-hierarchy
// contract, and journaled as an append-only economic_discrepancies row.
//
// HONESTY (inviolable):
//   - SURFACING ONLY. A DISCREPANCY is journaled LOUDLY (CRITICAL audit row)
//     and never auto-adjusted: this worker holds no reference to any posting
//     writer and check-vault-mutations forbids UPDATE/DELETE on the ledger.
//     Resolution is a human-authored correction journal.
//   - A stale or missing broker figure degrades to verdict UNKNOWN with the
//     reason recorded — never compared as if fresh, never synthesized.
//   - The first comparison ESTABLISHES a baseline and says so
//     (BASELINE_ESTABLISHED) — it does not claim MATCHED.
//
// WORKER IDIOM (copied from missionDriver.ts): unref'd interval,
// non-overlapping pass, per-user try/catch (a crash skips that user and the
// next pass retries from honest persisted state), ARX_*_ENABLED env opt-out
// logged loudly, registered in index.ts. FAIL SAFE: this worker holds no
// authority to change — a crash pauses reconciliation, nothing else.

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db,
  economicPostingsTable,
  economicDiscrepanciesTable,
  mt5ConnectionTable,
  liveTradingAuditTable,
} from "@workspace/db";
import { Money } from "@workspace/money";
import {
  compareLedgerToBroker,
  DEFAULT_BROKER_SNAPSHOT_STALE_AFTER_MS,
  type LedgerBrokerComparison,
} from "@workspace/accounting";
import { logger } from "../logger.js";

/** Daily cadence. On-demand runs call runEconomicReconciliationPass directly. */
export const ECONOMIC_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** PURE — is the worker enabled? Absent env = ENABLED. */
export function economicReconciliationEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !DISABLE_VALUES.has(raw.trim().toLowerCase());
}

export interface UserReconciliationOutcome {
  userId: number;
  verdict: string;
  reason: string;
  error: string | null;
}

export interface EconomicReconciliationPassResult {
  usersExamined: number;
  outcomes: UserReconciliationOutcome[];
}

/**
 * The broker's reported balance for this user, from the EXISTING snapshot
 * ingest. Freshness comes from accountSyncedAt (stamped only when the EA
 * delivered real balance/equity). Honest nulls throughout: no connection, no
 * sync, or an unusable currency all degrade to "unknown", never to a guess.
 */
async function loadBrokerSnapshot(userId: number, nowMs: number): Promise<{
  balance: Money | null;
  ageMs: number | null;
  currency: string | null;
}> {
  const rows = await db.select({
    balance: mt5ConnectionTable.accountBalance,
    currency: mt5ConnectionTable.accountCurrency,
    syncedAt: mt5ConnectionTable.accountSyncedAt,
  })
    .from(mt5ConnectionTable)
    .where(and(
      eq(mt5ConnectionTable.userId, userId),
      isNotNull(mt5ConnectionTable.accountSyncedAt),
    ))
    .orderBy(desc(mt5ConnectionTable.accountSyncedAt))
    .limit(1);
  const row = rows[0];
  if (!row || row.syncedAt == null) return { balance: null, ageMs: null, currency: null };
  const currency = row.currency?.trim().toUpperCase() ?? null;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return { balance: null, ageMs: null, currency: null };
  if (typeof row.balance !== "number" || !Number.isFinite(row.balance)) {
    return { balance: null, ageMs: null, currency };
  }
  let balance: Money;
  try {
    balance = Money.of(row.balance, currency);
  } catch {
    return { balance: null, ageMs: null, currency };
  }
  return { balance, ageMs: nowMs - row.syncedAt.getTime(), currency };
}

/** Sum of BROKER_CASH postings for user+ledger, exact, in minor units per currency/scale. */
async function loadLedgerCash(userId: number, ledger: string): Promise<{ minor: bigint; currency: string; scale: number } | null> {
  const rows = await db.select({
    total: sql<string>`coalesce(sum(${economicPostingsTable.amountMinor}), 0)::text`,
    currency: economicPostingsTable.currency,
    scale: economicPostingsTable.scale,
  })
    .from(economicPostingsTable)
    .where(and(
      eq(economicPostingsTable.userId, userId),
      eq(economicPostingsTable.ledger, ledger),
      eq(economicPostingsTable.account, "BROKER_CASH"),
    ))
    .groupBy(economicPostingsTable.currency, economicPostingsTable.scale);
  if (rows.length === 0) return null; // no cash postings yet — nothing to reconcile against
  if (rows.length > 1) return { minor: 0n, currency: "MIXED", scale: -1 }; // sentinel → UNKNOWN
  const r = rows[0]!;
  return { minor: BigInt(r.total), currency: r.currency, scale: r.scale };
}

/** Latest established baseline for user+ledger, or null. */
async function loadBaseline(userId: number, ledger: string): Promise<{ minor: bigint; currency: string; scale: number } | null> {
  const rows = await db.select({
    baseline: economicDiscrepanciesTable.baselineMinor,
    currency: economicDiscrepanciesTable.currency,
    scale: economicDiscrepanciesTable.scale,
  })
    .from(economicDiscrepanciesTable)
    .where(and(
      eq(economicDiscrepanciesTable.userId, userId),
      eq(economicDiscrepanciesTable.ledger, ledger),
      isNotNull(economicDiscrepanciesTable.baselineMinor),
    ))
    .orderBy(desc(economicDiscrepanciesTable.id))
    .limit(1);
  const r = rows[0];
  if (!r || r.baseline == null) return null;
  return { minor: r.baseline, currency: r.currency, scale: r.scale };
}

async function auditLoudly(args: {
  userId: number; severity: string; eventType: string; message: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(liveTradingAuditTable).values({
      eventId: randomUUID(),
      eventType: args.eventType,
      severity: args.severity,
      mode: "READ_ONLY",
      symbol: null,
      message: args.message,
      actorRole: "system",
      metadata: { userId: args.userId, ...args.metadata },
    });
  } catch (e) {
    logger.warn({ event: "ECONOMIC_RECON_AUDIT_WRITE_FAILED", error: e instanceof Error ? e.message : String(e) },
      "economic reconciliation audit write failed — discrepancy row is still the durable record");
  }
}

/** Reconcile ONE user's LIVE ledger. Returns the verdict written. */
async function reconcileUser(userId: number, trigger: "DAILY" | "ON_DEMAND", nowMs: number): Promise<UserReconciliationOutcome> {
  const ledger = "LIVE";
  const cash = await loadLedgerCash(userId, ledger);
  if (cash == null) {
    return { userId, verdict: "SKIPPED", reason: "no BROKER_CASH postings for this user yet", error: null };
  }

  let comparison: LedgerBrokerComparison;
  let currency = cash.currency;
  let scale = cash.scale;
  let brokerBalance: Money | null = null;
  let ageMs: number | null = null;

  if (cash.currency === "MIXED") {
    comparison = {
      verdict: "UNKNOWN",
      establishedBaseline: null,
      difference: null,
      truthWinner: null,
      reason: "ledger cash spans multiple currencies — refusing to collapse them into one figure",
    };
    currency = "MIXED";
    scale = 0;
  } else {
    const snapshot = await loadBrokerSnapshot(userId, nowMs);
    brokerBalance = snapshot.balance;
    ageMs = snapshot.ageMs;
    const ledgerCash = Money.fromMinor(cash.minor, cash.currency, cash.scale);
    const baselineRow = await loadBaseline(userId, ledger);
    const baseline =
      baselineRow && baselineRow.currency === cash.currency && baselineRow.scale === cash.scale
        ? Money.fromMinor(baselineRow.minor, baselineRow.currency, baselineRow.scale)
        : null;
    comparison = compareLedgerToBroker({
      brokerBalance: snapshot.balance,
      brokerSource: "BROKER_EVENT", // heartbeat/sync-account ingest is a broker-confirmed event, not a statement
      ledgerCash,
      ledgerSource: "LOCAL_EXECUTION",
      baseline,
      snapshotAgeMs: snapshot.ageMs,
      staleAfterMs: DEFAULT_BROKER_SNAPSHOT_STALE_AFTER_MS,
    });
  }

  // APPEND the observation — every verdict, not just discrepancies, so the
  // run history itself is evidence.
  await db.insert(economicDiscrepanciesTable).values({
    userId,
    ledger,
    verdict: comparison.verdict,
    brokerBalanceMinor: brokerBalance?.minor ?? null,
    ledgerCashMinor: cash.currency === "MIXED" ? 0n : cash.minor,
    baselineMinor: comparison.establishedBaseline?.minor
      ?? (comparison.verdict === "MATCHED" || comparison.verdict === "DISCREPANCY"
        ? (await loadBaseline(userId, ledger))?.minor ?? null
        : null),
    differenceMinor: comparison.difference?.minor ?? null,
    currency,
    scale,
    brokerSource: brokerBalance != null ? "BROKER_EVENT" : null,
    truthWinner: comparison.truthWinner,
    reason: comparison.reason,
    trigger,
    metadata: { snapshotAgeMs: ageMs },
  });

  if (comparison.verdict === "DISCREPANCY") {
    logger.error({
      event: "ECONOMIC_DISCREPANCY",
      userId, ledger,
      difference: comparison.difference?.toString(),
      truthWinner: comparison.truthWinner,
    }, "ECONOMIC DISCREPANCY — broker balance disagrees with the posting ledger; surfaced only, NOT auto-adjusted");
    await auditLoudly({
      userId,
      severity: "CRITICAL",
      eventType: "ECONOMIC_DISCREPANCY",
      message: comparison.reason,
      metadata: {
        ledger,
        differenceMinor: comparison.difference?.minor.toString() ?? null,
        currency,
        truthWinner: comparison.truthWinner,
        trigger,
      },
    });
  }

  return { userId, verdict: comparison.verdict, reason: comparison.reason, error: null };
}

/**
 * One full reconciliation pass over every user holding LIVE postings.
 * Fail-soft per user. Exported for ON_DEMAND invocation.
 */
export async function runEconomicReconciliationPass(
  trigger: "DAILY" | "ON_DEMAND" = "ON_DEMAND",
  nowMs: number = Date.now(),
): Promise<EconomicReconciliationPassResult> {
  const userRows = await db.selectDistinct({ userId: economicPostingsTable.userId })
    .from(economicPostingsTable)
    .where(eq(economicPostingsTable.ledger, "LIVE"));
  const outcomes: UserReconciliationOutcome[] = [];
  for (const { userId } of userRows) {
    try {
      outcomes.push(await reconcileUser(userId, trigger, nowMs));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error({ event: "ECONOMIC_RECON_USER_FAILED", userId, error: msg },
        "economic reconciliation failed for one user (skipped, fail-safe) — next pass retries");
      outcomes.push({ userId, verdict: "ERROR", reason: "pass crashed for this user", error: msg });
    }
  }
  return { usersExamined: userRows.length, outcomes };
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startEconomicReconciliationWorker(): void {
  if (timer) return;
  if (!economicReconciliationEnabled(process.env["ARX_ECONOMIC_RECONCILIATION_ENABLED"])) {
    logger.warn(
      { flag: "ARX_ECONOMIC_RECONCILIATION_ENABLED" },
      "economic_reconciliation_DISABLED_by_env — posting-vs-broker balance checks will NOT run; discrepancies go unsurfaced until re-enabled",
    );
    return;
  }
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runEconomicReconciliationPass("DAILY")
      .then((r) => {
        const notable = r.outcomes.filter((o) => o.verdict === "DISCREPANCY" || o.verdict === "ERROR");
        logger.info({
          usersExamined: r.usersExamined,
          discrepancies: notable.filter((o) => o.verdict === "DISCREPANCY").length,
          errors: notable.filter((o) => o.verdict === "ERROR").length,
        }, "economic_reconciliation_pass");
      })
      .catch((err) => logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "economic_reconciliation_pass_failed",
      ))
      .finally(() => { running = false; });
  }, ECONOMIC_RECONCILIATION_INTERVAL_MS).unref();
  logger.info({ intervalMs: ECONOMIC_RECONCILIATION_INTERVAL_MS }, "economic_reconciliation_started");
}

export function stopEconomicReconciliationWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
