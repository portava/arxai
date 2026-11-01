// ARX live account snapshot — shared truth adapter (PURE, read-only).
//
// PURPOSE
//   One normalized account+positions snapshot consumed by Dashboard, Open
//   Trades, Ruby, Risk Governor, and the Cockpit — so a single real account
//   fact never shows differently across surfaces. This module is a pure
//   function over already-fetched inputs: the caller does the user/role-scoped
//   DB read (open arx_live_positions rows + account equity) and supplies any
//   fresh broker quotes. The adapter normalizes P/L, derives honest freshness,
//   excludes non-open / reconciled / broker-absent rows, and emits a
//   unverified comparison marker: native same-account profit evidence is absent.
//
//   It performs NO I/O, mutates nothing, places no trades, and touches no
//   bridge/execution path.
//
// HONESTY RULES (non-negotiable — see the upgrade spec's final rule)
//   • Prefer broker-provided floating P/L when fresh. Compute from quote only
//     when a FRESH bid/ask exists (buy → bid, sell → ask). Otherwise the P/L is
//     marked estimated/unavailable — NEVER presented as live.
//   • Freshness is derived from real timestamps (snapshot age, quote age). A
//     stale value is labelled stale; it is never relabelled "live".
//   • Until the EA pushes quotes/per-tick P/L, the freshest possible P/L is the
//     last EA positions-snapshot value — so "live" here means "broker snapshot
//     is recent", NOT tick-by-tick. The adapter cannot and does not fabricate
//     sub-snapshot movement.
//   • Equity minus balance is arithmetic, not native account profit. Neither
//     equal numbers nor a supplied-row subtotal proves whole-account agreement.
//   • Quote-based P/L remains an estimate; its account-currency conversion is
//     not proven by this adapter. Per-position broker values remain distinct.

import { ACCOUNT_SNAPSHOT_LIVE_MS, ACCOUNT_SNAPSHOT_FRESH_MS, ACCOUNT_SNAPSHOT_DELAYED_MS } from "../brokerHub/freshness.js";
import { isSnapshotReliable, classifyRow } from "./positionFreshness.js";

export type AccountMode = "LIVE_SHARED" | "PAPER" | "DEMO" | "UNKNOWN";
export type Freshness = "live" | "fresh" | "delayed" | "stale" | "unavailable";
export type PlSource = "broker" | "computed" | "unavailable";

// Default freshness bands (ms). Tunable by the caller.
export const DEFAULT_LIVE_MS = ACCOUNT_SNAPSHOT_LIVE_MS;       // ≤5s → live
export const DEFAULT_FRESH_MS = ACCOUNT_SNAPSHOT_FRESH_MS;     // ≤30s → fresh
export const DEFAULT_DELAYED_MS = ACCOUNT_SNAPSHOT_DELAYED_MS; // ≤2m → delayed; beyond → stale

// Retained for compatibility with legacy callers. No comparison uses this USD
// threshold: a matched native same-account profit report is not available here.
export const PL_RECONCILIATION_TOLERANCE_USD = 1.0;

export interface LivePositionRow {
  id: number;
  brokerTicket: string | null;
  symbol: string;
  side: string;            // "buy" | "sell" (broker casing tolerated)
  volume: number;
  entryPrice: number;
  currentPrice: number | null;
  floatingPl: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  closedAt: Date | string | null;
  reconcileState: string | null; // non-null ⇒ reconciled/excluded from open view
  lastSyncedAtMs: number | null;
}

export interface QuoteInput {
  bid?: number;
  ask?: number;
  last?: number;
  spread?: number;
  /** Per-symbol contract size for compute-from-quote (defaults to 1 when absent). */
  contractSize?: number;
  tsMs: number; // quote timestamp
}

export interface LivePositionPL {
  positionId: string;
  brokerTicket?: string;
  symbol: string;
  direction: "buy" | "sell";
  volume: number;
  entryPrice: number;
  currentPrice: number | null;
  bid?: number;
  ask?: number;
  spread?: number;
  unrealizedPL: number | null;
  brokerPL?: number | null;
  computedPL?: number | null;
  plSource: PlSource;
  plIsEstimate: boolean;
  sl?: number | null;
  tp?: number | null;
  lastUpdateAtMs: number;
  freshness: Freshness;
}

/** Display diagnostics only. Supplied position rows and account scalars do not
 * prove a matched whole-account profit report, even when their numbers agree. */
export interface SnapshotReconciliation {
  status?: "unverified";
  reason?: "NO_MATCHED_ACCOUNT_PROFIT_REPORT";
  positionPnlScope?: "supplied_rows";
  /** All nonempty supplied rows have finite P/L; not a whole-account claim. */
  positionPnlComplete?: boolean;
  /** Known-row subtotal only. Null when absent or nonfinite. */
  snapshotSummedPL: number | null;
  /** Legacy name: arithmetic equity minus balance, NOT native broker profit. */
  equityMinusBalancePL: number | null;
  /** Unavailable until a matched native account-profit report exists. */
  discrepancy: number | null;
  /** False is not evidence of agreement; consult status. */
  exceedsThreshold: boolean;
  excludedCount: number;
  brokerAbsentExcludedCount: number;
  stalePLCount: number;
}

export interface LiveAccountSnapshot {
  userId: string;
  accountMode: AccountMode;
  source: "mt5" | "broker_snapshot" | "computed" | "fallback" | "unknown";
  balance: number | null;
  equity: number | null;
  margin: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
  /** When the EA last delivered balance/equity (epoch ms), or null if never. */
  accountSyncedAtMs: number | null;
  openPL: number | null;
  openPositionsCount: number;
  positions: LivePositionPL[];
  lastBrokerSnapshotAtMs?: number;
  lastQuoteUpdateAtMs?: number;
  lastComputedAtMs: number;
  freshness: Freshness;
  warnings: string[];
  /** Present when the server reports the user is not in live mode. */
  notLiveReason?: string;
  /** Reconciliation invariant result — always present on a live snapshot. */
  reconciliation?: SnapshotReconciliation;
}

export interface BuildSnapshotInput {
  userId: number;
  accountMode: AccountMode;
  /** Open rows ALREADY scoped to this user/role by the caller (isolation lives there). */
  rows: LivePositionRow[];
  /** Fresh broker quotes by symbol (omit a symbol to signal "no fresh quote"). */
  quotes?: Record<string, QuoteInput>;
  account?: {
    balance?: number | null;
    equity?: number | null;
    margin?: number | null;
    freeMargin?: number | null;
    marginLevel?: number | null;
    /** When the EA last delivered these account figures (epoch ms). */
    syncedAtMs?: number | null;
  };
  /** The bridge's last complete positions snapshot timestamp (epoch ms). Used
   *  to classify broker-confirmed-absent rows for display exclusion. When null
   *  or absent, the broker-absent pass is skipped and all closedAt=null rows
   *  without a reconcileState are kept visible (safe default). */
  lastPositionsSnapshotAtMs?: number | null;
  now: number;
  liveMs?: number;
  freshMs?: number;
  delayedMs?: number;
}

function freshnessFromAge(ageMs: number, liveMs: number, freshMs: number, delayedMs: number): Freshness {
  if (ageMs < 0) return "unavailable";
  if (ageMs <= liveMs) return "live";
  if (ageMs <= freshMs) return "fresh";
  if (ageMs <= delayedMs) return "delayed";
  return "stale";
}

function normSide(side: string): "buy" | "sell" {
  return side.toLowerCase() === "sell" ? "sell" : "buy";
}

/** A row counts as OPEN only when not closed and not reconciled away. */
function isOpenRow(r: LivePositionRow): boolean {
  if (r.closedAt != null) return false;
  // Any non-null reconcile_state means an operator/auto-reconciler resolved it
  // (broker-absent, external, imported, ignored) — it must not contribute P/L.
  if (r.reconcileState != null && r.reconcileState !== "") return false;
  return true;
}

/**
 * Compute one position's P/L line. Broker floating P/L is preferred when fresh;
 * otherwise compute mark-to-market from a fresh quote (buy→bid, sell→ask). When
 * neither is available the P/L is null/unavailable — never fabricated.
 */
export function normalizePositionPL(
  r: LivePositionRow,
  quote: QuoteInput | undefined,
  now: number,
  bands: { liveMs: number; freshMs: number; delayedMs: number },
): LivePositionPL {
  const direction = normSide(r.side);
  const snapshotAge = r.lastSyncedAtMs == null ? Number.POSITIVE_INFINITY : now - r.lastSyncedAtMs;
  const snapshotTimeKnown = Number.isFinite(now) && typeof r.lastSyncedAtMs === "number"
    && Number.isFinite(r.lastSyncedAtMs) && r.lastSyncedAtMs > 0 && snapshotAge >= 0;
  const snapshotFresh = snapshotTimeKnown && snapshotAge <= bands.delayedMs;

  const brokerPL = typeof r.floatingPl === "number" && Number.isFinite(r.floatingPl) ? r.floatingPl : null;

  // Compute-from-quote path: only with a fresh quote on the correct side.
  let computedPL: number | null = null;
  let markPrice: number | null = null;
  let quoteFresh = false;
  if (quote) {
    const quoteAge = now - quote.tsMs;
    quoteFresh = Number.isFinite(quote.tsMs) && quote.tsMs > 0 && Number.isFinite(quoteAge) && quoteAge >= 0 && quoteAge <= bands.delayedMs;
    const side = direction;
    const px = side === "buy" ? quote.bid : quote.ask; // buy marks to bid, sell to ask
    if (quoteFresh && typeof px === "number" && Number.isFinite(px) && Number.isFinite(r.entryPrice) && Number.isFinite(r.volume)) {
      markPrice = px;
      const cs = quote.contractSize ?? 1;
      const dir = side === "buy" ? 1 : -1;
      const estimate = (px - r.entryPrice) * dir * r.volume * cs;
      computedPL = Number.isFinite(cs) && cs > 0 && Number.isFinite(estimate) ? estimate : null;
    }
  }

  let unrealizedPL: number | null;
  let plSource: PlSource;
  let plIsEstimate: boolean;
  let lastUpdateAtMs: number;
  let freshness: Freshness;

  if (brokerPL != null && snapshotFresh) {
    // Preferred: broker-provided floating P/L from a non-stale snapshot.
    unrealizedPL = brokerPL;
    plSource = "broker";
    plIsEstimate = false;
    lastUpdateAtMs = r.lastSyncedAtMs ?? now;
    freshness = freshnessFromAge(snapshotAge, bands.liveMs, bands.freshMs, bands.delayedMs);
  } else if (computedPL != null) {
    // Fallback: mark-to-market from a fresh quote → explicitly an estimate.
    unrealizedPL = computedPL;
    plSource = "computed";
    plIsEstimate = true;
    lastUpdateAtMs = quote!.tsMs;
    freshness = freshnessFromAge(now - quote!.tsMs, bands.liveMs, bands.freshMs, bands.delayedMs);
  } else if (brokerPL != null && snapshotTimeKnown) {
    // We have a broker P/L but the snapshot is stale and no fresh quote — show
    // the last known value, clearly marked stale (never "live").
    unrealizedPL = brokerPL;
    plSource = "broker";
    plIsEstimate = true; // last-known, not current
    lastUpdateAtMs = r.lastSyncedAtMs ?? now;
    freshness = "stale";
  } else {
    // Nothing trustworthy to show.
    unrealizedPL = null;
    plSource = "unavailable";
    plIsEstimate = false;
    lastUpdateAtMs = r.lastSyncedAtMs ?? now;
    freshness = "unavailable";
  }

  return {
    positionId: `lp_${r.id}`,
    brokerTicket: r.brokerTicket ?? undefined,
    symbol: r.symbol,
    direction,
    volume: r.volume,
    entryPrice: r.entryPrice,
    currentPrice: markPrice ?? r.currentPrice ?? null,
    bid: quote?.bid,
    ask: quote?.ask,
    spread: quote?.spread,
    unrealizedPL,
    brokerPL,
    computedPL,
    plSource,
    plIsEstimate,
    sl: r.stopLoss,
    tp: r.takeProfit,
    lastUpdateAtMs,
    freshness,
  };
}

/**
 * Build the shared account snapshot. Pure: excludes closed/reconciled rows,
 * further excludes broker-confirmed-absent rows from the display count (without
 * mutating them), normalizes each open position's P/L, sums open P/L (only over
 * positions whose P/L is known, withholds incomplete totals), and derives an overall freshness = the WORST
 * freshness across contributing positions (so one stale leg can't masquerade as
 * a live total). Whole-account profit reconciliation remains unverified.
 */
export function buildLiveAccountSnapshot(input: BuildSnapshotInput): LiveAccountSnapshot {
  const bands = {
    liveMs: input.liveMs ?? DEFAULT_LIVE_MS,
    freshMs: input.freshMs ?? DEFAULT_FRESH_MS,
    delayedMs: input.delayedMs ?? DEFAULT_DELAYED_MS,
  };
  const warnings: string[] = [];

  // Pass 1: exclude closed rows and operator-reconciled rows.
  const afterClosedReconciled = input.rows.filter(isOpenRow);
  const excludedCount = input.rows.length - afterClosedReconciled.length;

  // Pass 2: exclude broker-confirmed-absent rows from the display count.
  // A row is broker-confirmed-absent when a reliable recent complete EA sweep
  // excluded it (i.e. the snapshot is fresh enough to trust as authoritative).
  // These rows are NOT mutated here — reconcileState stays null until the
  // broker-absence guardrail explicitly stamps them (ALERT_ONLY rule).
  const snapshotWindowMs = bands.delayedMs;
  const snapshotReliable = input.lastPositionsSnapshotAtMs != null
    ? isSnapshotReliable(input.lastPositionsSnapshotAtMs, snapshotWindowMs, input.now)
    : false;

  const openRows: LivePositionRow[] = [];
  let brokerAbsentExcludedCount = 0;
  for (const r of afterClosedReconciled) {
    const { brokerConfirmedAbsent } = classifyRow(r.lastSyncedAtMs, {
      windowMs: snapshotWindowMs,
      now: input.now,
      snapshotReliable,
    });
    if (brokerConfirmedAbsent) {
      brokerAbsentExcludedCount++;
    } else {
      openRows.push(r);
    }
  }

  if (brokerAbsentExcludedCount > 0) {
    warnings.push(
      `${brokerAbsentExcludedCount} position${brokerAbsentExcludedCount > 1 ? "s" : ""} awaiting broker reconciliation — not counted in open totals.`,
    );
  }

  const positions = openRows.map((r) =>
    normalizePositionPL(r, input.quotes?.[r.symbol], input.now, bands),
  );

  // Preserve real per-position values, but never promote a known subtotal to
  // the total when another row is unknown. Even a complete row sum is scoped
  // only to these supplied rows, not the entire broker account.
  let knownSubtotal: number | null = null;
  let anyUnknown = false;
  for (const p of positions) {
    if (p.unrealizedPL == null || !Number.isFinite(p.unrealizedPL)) { anyUnknown = true; continue; }
    knownSubtotal = (knownSubtotal ?? 0) + p.unrealizedPL;
  }
  if (knownSubtotal != null && !Number.isFinite(knownSubtotal)) { knownSubtotal = null; anyUnknown = true; }
  const positionPnlComplete = positions.length > 0 && !anyUnknown && knownSubtotal != null;
  const openPL = positionPnlComplete ? knownSubtotal : null;
  if (anyUnknown) warnings.push("Position P/L is incomplete — one or more supplied positions has no usable value. The known subtotal is not the total.");

  // Overall freshness = worst across contributing positions (rank order).
  const rank: Record<Freshness, number> = { live: 0, fresh: 1, delayed: 2, stale: 3, unavailable: 4 };
  let overall: Freshness = positions.length === 0 ? "fresh" : "live";
  for (const p of positions) {
    if (rank[p.freshness] > rank[overall]) overall = p.freshness;
  }

  // Equity includes components other than open-position profit (such as
  // credit). These scalar fields may also describe a different connection or
  // observation from the user-scoped rows. Keep their arithmetic diagnostic
  // distinct from native ACCOUNT_PROFIT; no equality can establish agreement.
  const acct = input.account ?? {};
  const difference = typeof acct.balance === "number" && Number.isFinite(acct.balance)
    && typeof acct.equity === "number" && Number.isFinite(acct.equity)
    ? acct.equity - acct.balance : null;
  const equityMinusBalancePL = difference != null && Number.isFinite(difference) ? difference : null;

  const stalePLCount = positions.filter(
    (p) => p.plIsEstimate || p.plSource === "unavailable",
  ).length;

  const reconciliation: SnapshotReconciliation = {
    status: "unverified",
    reason: "NO_MATCHED_ACCOUNT_PROFIT_REPORT",
    positionPnlScope: "supplied_rows",
    positionPnlComplete,
    snapshotSummedPL: knownSubtotal,
    equityMinusBalancePL,
    discrepancy: null,
    exceedsThreshold: false,
    excludedCount,
    brokerAbsentExcludedCount,
    stalePLCount,
  };

  const newestSnapshotMs = openRows.reduce<number | null>((acc, r) => {
    if (r.lastSyncedAtMs == null || !Number.isFinite(r.lastSyncedAtMs) || r.lastSyncedAtMs <= 0 || r.lastSyncedAtMs > input.now) return acc;
    return acc == null || r.lastSyncedAtMs > acc ? r.lastSyncedAtMs : acc;
  }, null);
  const newestQuoteMs = input.quotes
    ? Object.values(input.quotes).reduce<number | null>((acc, q) => !Number.isFinite(q.tsMs) || q.tsMs <= 0 || q.tsMs > input.now ? acc : (acc == null || q.tsMs > acc ? q.tsMs : acc), null)
    : null;

  return {
    userId: String(input.userId),
    accountMode: input.accountMode,
    source: openRows.length > 0 ? "broker_snapshot" : "computed",
    balance: acct.balance ?? null,
    equity: acct.equity ?? null,
    margin: acct.margin ?? null,
    freeMargin: acct.freeMargin ?? null,
    marginLevel: acct.marginLevel ?? null,
    accountSyncedAtMs: acct.syncedAtMs ?? null,
    openPL,
    openPositionsCount: positions.length,
    positions,
    lastBrokerSnapshotAtMs: newestSnapshotMs ?? undefined,
    lastQuoteUpdateAtMs: newestQuoteMs ?? undefined,
    lastComputedAtMs: input.now,
    freshness: overall,
    warnings,
    reconciliation,
  };
}
