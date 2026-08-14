// Investor Portal (Task #72) — shared service helpers.
//
// SAFETY / DESIGN:
// - Pure, per-user data helpers. Every function that reads investor data takes
//   an explicit userId and scopes every query by it. No cross-user reads.
// - Allocation preferences are intent-only. NONE of these helpers touch any
//   execution path, lot sizing, the 16-gate live pipeline, or any broker
//   surface. They only read/derive view data and validate intent shapes.
// - Metrics are honest: with no trading wired for investors, realized and
//   unrealized P/L are 0 and performance is reported as "no data" rather than
//   fabricated returns. NEVER emit guaranteed/fixed-return figures.

import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  investorProfilesTable,
  investorLedgerEntriesTable,
  investorAllocationPreferencesTable,
  investorStrategyProfilesTable,
  investorAllocationSettingsTable,
  type InvestorProfile,
  type InvestorLedgerEntry,
  type InvestorAllocationPreference,
  type InvestorStrategyProfile,
  type InvestorAllocationSettings,
} from "@workspace/db";

export const DEFAULT_MAX_AGGRESSIVE_PCT = 50;
export const DEFAULT_RISK_DISCLOSURE_VERSION = "v1";

// Sensible default sleeve splits used to seed the strategy profiles the first
// time an admin (or an investor read) touches them. Admin-editable thereafter.
export const DEFAULT_STRATEGY_PROFILES: Array<{
  profileKey: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";
  label: string;
  description: string;
  conservativePct: number;
  balancedPct: number;
  aggressivePct: number;
}> = [
  {
    profileKey: "CONSERVATIVE",
    label: "Conservative",
    description: "Lower-volatility tilt. Capital preservation focus.",
    conservativePct: 70,
    balancedPct: 30,
    aggressivePct: 0,
  },
  {
    profileKey: "BALANCED",
    label: "Balanced",
    description: "A blended mix across sleeves.",
    conservativePct: 40,
    balancedPct: 40,
    aggressivePct: 20,
  },
  {
    profileKey: "AGGRESSIVE",
    label: "Aggressive",
    description: "Higher-volatility tilt. Larger swings expected.",
    conservativePct: 20,
    balancedPct: 30,
    aggressivePct: 50,
  },
];

const TERMINAL_OR_INACTIVE = new Set(["REJECTED", "SUPERSEDED"]);

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Load (or lazily seed) the singleton allocation-settings row.
export async function ensureSettings(): Promise<InvestorAllocationSettings> {
  const rows = await db.select().from(investorAllocationSettingsTable).limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db
    .insert(investorAllocationSettingsTable)
    .values({
      maxAggressivePct: DEFAULT_MAX_AGGRESSIVE_PCT,
      riskDisclosureVersion: DEFAULT_RISK_DISCLOSURE_VERSION,
    })
    .returning();
  return inserted[0];
}

// Load (or lazily seed any missing) strategy-profile presets. Always returns
// the three canonical presets ordered conservative→aggressive.
export async function ensureStrategyProfiles(): Promise<InvestorStrategyProfile[]> {
  const existing = await db.select().from(investorStrategyProfilesTable);
  const byKey = new Map(existing.map((p) => [p.profileKey, p]));
  const missing = DEFAULT_STRATEGY_PROFILES.filter((d) => !byKey.has(d.profileKey));
  if (missing.length > 0) {
    await db.insert(investorStrategyProfilesTable).values(missing);
  }
  const all = await db.select().from(investorStrategyProfilesTable);
  const order = ["CONSERVATIVE", "BALANCED", "AGGRESSIVE"];
  return all
    .filter((p) => order.includes(p.profileKey))
    .sort((a, b) => order.indexOf(a.profileKey) - order.indexOf(b.profileKey));
}

export async function getProfile(userId: number): Promise<InvestorProfile | null> {
  const rows = await db
    .select()
    .from(investorProfilesTable)
    .where(eq(investorProfilesTable.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getLedger(userId: number): Promise<InvestorLedgerEntry[]> {
  return db
    .select()
    .from(investorLedgerEntriesTable)
    .where(eq(investorLedgerEntriesTable.userId, userId))
    .orderBy(desc(investorLedgerEntriesTable.createdAt));
}

export async function getPreferences(
  userId: number,
): Promise<InvestorAllocationPreference[]> {
  return db
    .select()
    .from(investorAllocationPreferencesTable)
    .where(eq(investorAllocationPreferencesTable.userId, userId))
    .orderBy(desc(investorAllocationPreferencesTable.createdAt));
}

export type InvestorMetrics = {
  hasFunds: boolean;
  depositedTotal: number;
  withdrawnTotal: number;
  adjustmentsTotal: number;
  netContributed: number;
  currentValue: number;
  realizedPnl: number;
  unrealizedPnl: number;
  hasPerformanceData: boolean;
  monthlyReturnPct: number | null;
  allTimeReturnPct: number | null;
};

// Derive the honest portfolio metrics from the ledger. Investors do not trade
// directly, but admins may credit real, dated PERFORMANCE figures (a recorded
// gain/loss attributed to the investor). Realized P/L is the sum of those
// figures; contributions (deposits/withdrawals/adjustments) are tracked
// separately. Returns are computed only from real recorded figures — never
// projected, fixed, or guaranteed. With no PERFORMANCE rows the return fields
// stay null and the UI shows an honest "—".
export function computeMetrics(ledger: InvestorLedgerEntry[]): InvestorMetrics {
  let deposited = 0;
  let withdrawn = 0;
  let adjustments = 0;
  let performance = 0;
  let performanceCount = 0;
  for (const e of ledger) {
    const amt = Number(e.signedAmount);
    if (e.entryType === "DEPOSIT") deposited += amt;
    else if (e.entryType === "WITHDRAWAL") withdrawn += amt; // already negative
    else if (e.entryType === "PERFORMANCE") {
      performance += amt;
      performanceCount += 1;
    } else adjustments += amt;
  }
  // Contributions exclude PERFORMANCE — recorded returns are not new capital.
  const netContributed = deposited + withdrawn + adjustments;
  const realizedPnl = performance;
  const unrealizedPnl = 0;
  const currentValue = netContributed + realizedPnl + unrealizedPnl;

  // Headline returns: only meaningful once real PERFORMANCE figures exist.
  // All-time return = cumulative recorded performance as a % of net capital
  // contributed. Monthly return = the most recent recorded PERFORMANCE figure
  // as a % of the running account value immediately before it (admins record
  // these on a periodic, typically monthly, cadence). Both stay null when there
  // is no real figure or no positive base — never invented.
  const hasPerformanceData = performanceCount > 0;
  const allTimeReturnPct =
    hasPerformanceData && netContributed > 0
      ? round2((performance / netContributed) * 100)
      : null;

  let monthlyReturnPct: number | null = null;
  if (hasPerformanceData) {
    const ascending = [...ledger].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    let running = 0;
    let latest: { amount: number; base: number } | null = null;
    for (const e of ascending) {
      const amt = Number(e.signedAmount);
      if (e.entryType === "PERFORMANCE") latest = { amount: amt, base: running };
      running += amt;
    }
    if (latest && latest.base > 0) {
      monthlyReturnPct = round2((latest.amount / latest.base) * 100);
    }
  }

  return {
    hasFunds: ledger.length > 0,
    depositedTotal: round2(deposited),
    withdrawnTotal: round2(Math.abs(withdrawn)),
    adjustmentsTotal: round2(adjustments),
    netContributed: round2(netContributed),
    currentValue: round2(currentValue),
    realizedPnl: round2(realizedPnl),
    unrealizedPnl,
    hasPerformanceData,
    monthlyReturnPct,
    allTimeReturnPct,
  };
}

// ── Bulk PERFORMANCE posting (Task #86) ─────────────────────────────────────
// Admins post a fund's periodic (typically monthly) return to many investors in
// one action. Two honest modes, both producing a REAL, dated PERFORMANCE figure
// per investor — never a projected, fixed, or guaranteed return:
//   FIXED    — credit the SAME signed figure to every selected investor.
//   PRO_RATA — credit `value`% of each investor's current account value, so the
//              figure scales with the investor's real balance.
export type BulkPerformanceMode = "FIXED" | "PRO_RATA";

// Compute the signed PERFORMANCE amount for one investor. `value` is the signed
// figure (FIXED) or the signed percent (PRO_RATA). For PRO_RATA a non-positive
// base produces 0 — there is no real return to attribute, so the caller skips it
// rather than inventing one.
export function computeBulkPerformanceAmount(
  mode: BulkPerformanceMode,
  value: number,
  currentValue: number,
): number {
  if (mode === "PRO_RATA") {
    if (!(currentValue > 0)) return 0;
    return round2((currentValue * value) / 100);
  }
  return round2(value);
}

// Build the ledger `reason` string for a bulk-posted PERFORMANCE row, folding
// the period label in so every individual row stays attributed to the period it
// belongs to (the row's createdAt supplies the date).
export function bulkPerformanceReason(periodLabel: string, reason: string): string {
  return `[${periodLabel.trim()}] ${reason.trim()}`;
}

// Build the ledger `reason` string for an offsetting PERFORMANCE row written by
// a batch reversal (Task #107). Keeps the original period label visible and
// folds the admin's reversal reason in so each offsetting row stays honestly
// attributed to the reversal it belongs to.
export function reversalPerformanceReason(periodLabel: string, reason: string): string {
  return `[Reversal · ${periodLabel.trim()}] ${reason.trim()}`;
}

// A single point on the investor equity curve. `value` is the cumulative
// recorded account value at `at` — contributions plus any recorded performance.
// This is REAL, dated, per-user activity from the append-only ledger — never
// simulated or projected.
export type InvestorEquityPoint = {
  at: string;
  label: string;
  value: number;
};

// Build the equity time-series from the investor's real ledger entries.
// Walks the ledger in chronological order, accumulating the signed amounts into
// a running account value, and emits one point per day (the end-of-day value
// when several entries land on the same day). Empty ledger → empty series, so
// the Performance tab keeps its honest empty state. Nothing here is projected,
// guaranteed, or implied — it is the recorded account value over time.
export function computeEquitySeries(
  ledger: InvestorLedgerEntry[],
): InvestorEquityPoint[] {
  if (ledger.length === 0) return [];
  const ascending = [...ledger].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const byDay = new Map<string, { at: Date; value: number }>();
  let running = 0;
  for (const e of ascending) {
    running += Number(e.signedAmount);
    const dayKey = e.createdAt.toISOString().slice(0, 10);
    byDay.set(dayKey, { at: e.createdAt, value: round2(running) });
  }
  return [...byDay.values()].map((p) => ({
    at: p.at.toISOString(),
    label: p.at.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    value: p.value,
  }));
}

export function activePref(
  prefs: InvestorAllocationPreference[],
): InvestorAllocationPreference | null {
  return prefs.find((p) => p.status === "ACTIVE") ?? null;
}

// A non-terminal request blocking a new submission: DRAFT or PENDING_APPROVAL.
export function pendingPref(
  prefs: InvestorAllocationPreference[],
): InvestorAllocationPreference | null {
  return (
    prefs.find((p) => p.status === "PENDING_APPROVAL" || p.status === "DRAFT") ?? null
  );
}

export function isInactivePref(p: InvestorAllocationPreference): boolean {
  return TERMINAL_OR_INACTIVE.has(p.status);
}

// Serialize a preference row to the public (and admin) DTO shape.
export function prefToDto(p: InvestorAllocationPreference) {
  return {
    id: p.id,
    profileKey: p.profileKey,
    conservativePct: p.conservativePct,
    balancedPct: p.balancedPct,
    aggressivePct: p.aggressivePct,
    status: p.status,
    reviewNote: p.reviewNote ?? null,
    submittedAt: p.submittedAt ? p.submittedAt.toISOString() : null,
    reviewedAt: p.reviewedAt ? p.reviewedAt.toISOString() : null,
    activatedAt: p.activatedAt ? p.activatedAt.toISOString() : null,
    supersededAt: p.supersededAt ? p.supersededAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
  };
}

// Count pending (non-terminal) allocation requests for a user — used by the
// admin list to badge investors awaiting review.
export async function countPendingRequests(userId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(investorAllocationPreferencesTable)
    .where(
      and(
        eq(investorAllocationPreferencesTable.userId, userId),
        eq(investorAllocationPreferencesTable.status, "PENDING_APPROVAL"),
      ),
    );
  return rows[0]?.n ?? 0;
}
