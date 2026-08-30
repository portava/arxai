// ═══════════════════════════════════════════════════════════════════════════
// EDGE CAPACITY DERIVATION — the arithmetic behind a capacity proposal.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE COLLECTOR:
//
// This is the R-multiple math, the drop classification, the slippage formula
// and the venue-failure heuristic that decide what number the operator is
// shown on the surface gate #23's refusal points at. It used to live inline
// inside `gatherEdgeCapacityEvidence`'s try blocks, wrapped around live
// `db.select` calls, where the ONLY thing a test could do was read the file as
// text and grep it. Valid SQL is not correct arithmetic: a wrong denominator, a
// mis-attributed venue failure or a misread referencePrice does not throw and
// does not fail a source grep — it produces a PLAUSIBLE WRONG NUMBER carrying a
// LOW/MODERATE confidence label, which is the failure this whole hold exists to
// prevent.
//
// So the arithmetic is here: no `db` import, no IO, no clock, pure functions
// over plain rows. Pinned behaviourally by
// src/lib/learning/__qa__/edgeCapacityDerivation.test.ts.
//
// ── READ-ONLY BY CONSTRUCTION ──────────────────────────────────────────────
// No write verb may ever appear in this file. It cannot even reach a database.
//
// ── THE HONESTY SPINE ──────────────────────────────────────────────────────
// Every row that cannot be resolved into a real R multiple is DROPPED, counted
// and NAMED. There is no path here that back-fills an assumed stop-loss, an
// assumed contract size, an assumed FX rate, or a zero standing in for "we
// could not tell". A dropped row lowers the sample size the operator sees; it
// never silently becomes a data point.
// ═══════════════════════════════════════════════════════════════════════════

/** One closed position attributed to an edge, as the collector reads it.
 *  Every numeric is `unknown` because these arrive from the driver as numerics,
 *  strings or null depending on column type — coercion is this file's job. */
export interface ClosedPositionRow {
  userId: number;
  symbol: string;
  volume: unknown;
  entryPrice: unknown;
  stopLoss: unknown;
  /** Broker-REPORTED realised P&L. Never locally inferred. */
  realisedPnl: unknown;
  /** When the broker reported the close. null = never reported. */
  closeReportedAt: Date | string | null;
  reconcileState: string | null;
}

/** The broker contract spec for one (user, symbol). */
export interface SymbolSpec {
  contractSize: unknown;
  profitCurrency: string | null;
}

/** One confirmed entry command carrying the edge. */
export interface EntryCommandRow {
  filledAt: Date | string | null;
  rejectedAt: Date | string | null;
  expiredAt: Date | string | null;
  requestedVolume: unknown;
  executedVolume: unknown;
  fillPrice: unknown;
  stopLoss: unknown;
  payload: unknown;
}

export interface RealizedDerivation {
  /** Realised P&L ÷ planned risk, one per R-resolvable closed position. */
  rMultiples: number[];
  /** Attributed closed positions that could NOT be resolved, by reason. */
  dropped: Array<{ reason: string; count: number }>;
  /** Closes the venue mishandled: the observable behind the simulator's
   *  broker-failure leg. Counted over ALL attributed closes, resolvable or
   *  not — a position the broker lost is exactly the one with no numbers. */
  venueFailures: number;
}

export interface LiquidityDerivation {
  dispatch: { filled: number; rejected: number; expired: number; stillInFlight: number };
  slippageRSamples: number[];
  partialFillMean01: number | null;
  partialFillSamples: number;
}

/** The reconcile state that means "the broker does not have this position". */
export const RECONCILED_BROKER_ABSENT = "RECONCILED_BROKER_ABSENT";

/** Drop reasons, named once so the test and the operator read the same string. */
export const DROP_NO_PNL = "no broker-reported realised P&L (outcome UNRECONCILED)";
export const DROP_NO_STOP = "no stop-loss recorded, so the position has no planned risk";
export const DROP_NO_ENTRY = "no entry price recorded";
export const DROP_NO_VOLUME = "no volume recorded";
export const DROP_NO_SPEC = "no broker contract spec for this user+symbol";
export const DROP_NO_CONTRACT_SIZE = "contract size missing from the broker spec";
export const DROP_ZERO_RISK = "entry equals stop-loss, so planned risk is zero";
export function dropNonUsdCurrency(currency: string | null): string {
  return `profit currency ${currency ?? "UNKNOWN"} — no close-time FX rate is recorded, so P&L cannot be normalised`;
}

/** Coerce to a finite number, or null. A non-finite value is ABSENT, not zero. */
export function finite(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read `payload.referencePrice` — the draft-time price the user approved —
 * without trusting the payload's shape. Anything that is not a POSITIVE finite
 * number is absent, not zero: a zero reference price would make every fill look
 * like infinite slippage, and a negative one is not a price at all.
 */
export function referencePriceOf(payload: unknown): number | null {
  if (payload == null || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)["referencePrice"];
  const n = finite(v);
  return n != null && n > 0 ? n : null;
}

/**
 * The key a symbol spec is looked up by. Specs are per (owning user, symbol) —
 * user A's broker spec may not stand in for user B's.
 */
export function specKey(userId: number, symbol: string): string {
  return `${userId}:${symbol}`;
}

/**
 * Derive the realized R-multiple distribution and the venue-failure count from
 * the closed positions attributed to one edge.
 *
 * R = broker-reported realised P&L ÷ PLANNED risk, where planned risk is
 * |entry − stop| × contractSize × volume. Every factor must be present and
 * real; a position missing any of them is dropped by name.
 */
export function deriveRealizedEvidence(
  closed: readonly ClosedPositionRow[],
  specByKey: ReadonlyMap<string, SymbolSpec>,
): RealizedDerivation {
  const rMultiples: number[] = [];
  const drops = new Map<string, number>();
  const drop = (reason: string) => drops.set(reason, (drops.get(reason) ?? 0) + 1);
  let venueFailures = 0;

  for (const p of closed) {
    // Venue-failure observable: the broker closed it but reported no usable
    // numbers, or it was reconciled as absent from the broker entirely.
    if (p.reconcileState === RECONCILED_BROKER_ABSENT
      || (p.closeReportedAt != null && finite(p.realisedPnl) == null)) {
      venueFailures += 1;
    }

    const pnl = finite(p.realisedPnl);
    if (pnl == null) { drop(DROP_NO_PNL); continue; }
    const stop = finite(p.stopLoss);
    if (stop == null || stop <= 0) { drop(DROP_NO_STOP); continue; }
    const entry = finite(p.entryPrice);
    if (entry == null || entry <= 0) { drop(DROP_NO_ENTRY); continue; }
    const vol = finite(p.volume);
    if (vol == null || vol <= 0) { drop(DROP_NO_VOLUME); continue; }
    const spec = specByKey.get(specKey(p.userId, p.symbol));
    if (spec == null) { drop(DROP_NO_SPEC); continue; }
    const contractSize = finite(spec.contractSize);
    if (contractSize == null || contractSize <= 0) { drop(DROP_NO_CONTRACT_SIZE); continue; }
    if (spec.profitCurrency !== "USD") {
      // A non-USD profit currency needs an FX rate at close time that this
      // system does not store. Converting with today's rate would be a
      // fabricated number wearing a historical label.
      drop(dropNonUsdCurrency(spec.profitCurrency));
      continue;
    }
    const plannedRiskUsd = Math.abs(entry - stop) * contractSize * vol;
    if (!(plannedRiskUsd > 0)) { drop(DROP_ZERO_RISK); continue; }
    rMultiples.push(pnl / plannedRiskUsd);
  }

  return {
    rMultiples,
    dropped: Array.from(drops.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    venueFailures,
  };
}

/**
 * Derive dispatch outcomes, partial-fill ratio and realized slippage from the
 * confirmed entry commands carrying one edge.
 *
 * Slippage is |fill − payload.referencePrice| ÷ |fill − stop|, which is already
 * in planned-risk R: contract size and volume appear in both numerator and
 * denominator and cancel exactly, so no spec lookup is needed and no spec gap
 * can silently zero it out. A command missing any of the three prices yields NO
 * sample rather than a zero-slippage sample — a fabricated zero here would
 * OVERSTATE capacity, which is the dangerous direction.
 */
export function deriveLiquidityEvidence(
  cmds: readonly EntryCommandRow[],
): LiquidityDerivation {
  let filled = 0, rejected = 0, expired = 0, stillInFlight = 0;
  const partialRatios: number[] = [];
  const slippage: number[] = [];

  for (const c of cmds) {
    if (c.filledAt != null) filled += 1;
    else if (c.rejectedAt != null) rejected += 1;
    else if (c.expiredAt != null) expired += 1;
    else { stillInFlight += 1; continue; }

    // Only a FILLED command carries a fill price and an executed volume.
    if (c.filledAt == null) continue;

    const req = finite(c.requestedVolume);
    const exec = finite(c.executedVolume);
    if (req != null && req > 0 && exec != null && exec > 0) {
      partialRatios.push(Math.min(1, exec / req));
    }

    const fill = finite(c.fillPrice);
    const ref = referencePriceOf(c.payload);
    const stop = finite(c.stopLoss);
    if (fill != null && fill > 0 && ref != null && stop != null && stop > 0) {
      const riskDistance = Math.abs(fill - stop);
      if (riskDistance > 0) slippage.push(Math.abs(fill - ref) / riskDistance);
    }
  }

  return {
    dispatch: { filled, rejected, expired, stillInFlight },
    slippageRSamples: slippage,
    partialFillSamples: partialRatios.length,
    partialFillMean01: partialRatios.length > 0
      ? partialRatios.reduce((s, x) => s + x, 0) / partialRatios.length
      : null,
  };
}
