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
//   reconciliation marker when the summed P/L cannot be reconciled with the
//   authoritative equity − balance figure.
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
//   • When summed open P/L materially disagrees with equity − balance, the
//     snapshot carries a reconciliation discrepancy marker. The UI must surface
//     "P/L under verification" — never show the stale figure as normal profit.

import { isSnapshotReliable, classifyRow } from "./positionFreshness.js";

export type AccountMode = "LIVE_SHARED" | "PAPER" | "DEMO" | "UNKNOWN";
export type Freshness = "live" | "fresh" | "delayed" | "stale" | "unavailable";
export type PlSource = "broker" | "computed" | "unavailable";

// Default freshness bands (ms). Tunable by the caller.
export const DEFAULT_LIVE_MS = 5_000;      // ≤5s → live
export const DEFAULT_FRESH_MS = 30_000;    // ≤30s → fresh
export const DEFAULT_DELAYED_MS = 120_000; // ≤2m → delayed; beyond → stale

// Tolerance for equity − balance vs summed open P/L reconciliation. Within
// this band the figures are consistent (broker rounding, spread, unsettled
// charges). Beyond it the dashboard shows "P/L under verification" rather than
// the stale summed value as live green profit. Single shared constant — the
// invariant math and the UI gate use the SAME value so they can never disagree.
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

/**
 * Reconciliation marker emitted when the snapshot's summed position P/L is
 * compared to the authoritative equity − balance from the EA heartbeat. A
 * non-zero exceedsThreshold means the displayed open P/L is unreliable and
 * the UI must surface "P/L under verification" rather than normal live profit.
 */
export interface SnapshotReconciliation {
  /** Summed open P/L across positions with a known P/L value. */
  snapshotSummedPL: number | null;
  /** equity − balance from the EA heartbeat (authoritative floating P/L). */
  equityMinusBalancePL: number | null;
  /** |snapshotSummedPL − equityMinusBalancePL|; null when either is unavailable. */
  discrepancy: number | null;
  /** True when discrepancy > PL_RECONCILIATION_TOLERANCE_USD. */
  exceedsThreshold: boolean;
  /** Rows excluded by closedAt or non-null reconcileState filter. */
  excludedCount: number;
  /** Rows additionally excluded as broker-confirmed-absent (display-only;
   *  rows are NOT mutated — reconcileState stays null until the reconciler
   *  explicitly stamps them, per the broker-absence guardrail). */
  brokerAbsentExcludedCount: number;
  /** Positions whose P/L is estimated or unavailable (not fresh broker P/L). */
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
  const snapshotFresh = snapshotAge <= bands.delayedMs;

  const brokerPL = typeof r.floatingPl === "number" ? r.floatingPl : null;

  // Compute-from-quote path: only with a fresh quote on the correct side.
  let computedPL: number | null = null;
  let markPrice: number | null = null;
  let quoteFresh = false;
  if (quote) {
    const quoteAge = now - quote.tsMs;
    quoteFresh = quoteAge >= 0 && quoteAge <= bands.delayedMs;
    const side = direction;
    const px = side === "buy" ? quote.bid : quote.ask; // buy marks to bid, sell to ask
    if (quoteFresh && typeof px === "number") {
      markPrice = px;
      const cs = quote.contractSize ?? 1;
      const dir = side === "buy" ? 1 : -1;
      computedPL = (px - r.entryPrice) * dir * r.volume * cs;
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
  } else if (brokerPL != null) {
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
 * positions whose P/L is known), and derives an overall freshness = the WORST
 * freshness across contributing positions (so one stale leg can't masquerade as
 * a live total). Emits a reconciliation marker when summed P/L materially
 * disagrees with equity − balance.
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

  // Open P/L: sum only positions with a known P/L. If ANY open position has an
  // unknown P/L, the total is an under-count → flag it rather than imply exact.
  let openPL: number | null = null;
  let anyUnknown = false;
  for (const p of positions) {
    if (p.unrealizedPL == null) { anyUnknown = true; continue; }
    openPL = (openPL ?? 0) + p.unrealizedPL;
  }
  if (positions.length > 0 && openPL == null) openPL = null; // all unknown
  if (anyUnknown && positions.length > 0) {
    warnings.push("Some open positions are awaiting a fresh broker update — open P/L may be incomplete.");
  }

  // Overall freshness = worst across contributing positions (rank order).
  const rank: Record<Freshness, number> = { live: 0, fresh: 1, delayed: 2, stale: 3, unavailable: 4 };
  let overall: Freshness = positions.length === 0 ? "fresh" : "live";
  for (const p of positions) {
    if (rank[p.freshness] > rank[overall]) overall = p.freshness;
  }

  // Reconciliation invariant: compare summed position P/L to equity − balance.
  // The EA heartbeat's equity − balance is the authoritative floating P/L for
  // the broker account. If the summed per-row floatingPl materially disagrees,
  // the rows are stale/unreconciled and the displayed number must not be shown
  // as normal live profit. The discrepancy marker flows to the UI via the SSE
  // stream; the UI gates "P/L under verification" on exceedsThreshold.
  const acct = input.account ?? {};
  const acctBalance = acct.balance ?? null;
  const acctEquity = acct.equity ?? null;
  const equityMinusBalancePL =
    acctBalance != null && acctEquity != null
      ? Math.round((acctEquity - acctBalance) * 100) / 100
      : null;
  const discrepancy =
    openPL != null && equityMinusBalancePL != null
      ? Math.round(Math.abs(openPL - equityMinusBalancePL) * 100) / 100
      : null;
  const exceedsThreshold =
    discrepancy != null && discrepancy > PL_RECONCILIATION_TOLERANCE_USD;

  if (exceedsThreshold) {
    // User-safe copy — no raw P/L amounts, no internal field names.
    warnings.push(
      "Open P/L is under verification — position totals are being reconciled with broker data.",
    );
  }

  const stalePLCount = positions.filter(
    (p) => p.plIsEstimate || p.plSource === "unavailable",
  ).length;

  const reconciliation: SnapshotReconciliation = {
    snapshotSummedPL: openPL,
    equityMinusBalancePL,
    discrepancy,
    exceedsThreshold,
    excludedCount,
    brokerAbsentExcludedCount,
    stalePLCount,
  };

  const newestSnapshotMs = openRows.reduce<number | null>((acc, r) => {
    if (r.lastSyncedAtMs == null) return acc;
    return acc == null || r.lastSyncedAtMs > acc ? r.lastSyncedAtMs : acc;
  }, null);
  const newestQuoteMs = input.quotes
    ? Object.values(input.quotes).reduce<number | null>((acc, q) => (acc == null || q.tsMs > acc ? q.tsMs : acc), null)
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
