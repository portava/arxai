import type { MarketTruthResponse } from "@workspace/api-client-react";
import {
  classifyTruthEvidence,
  downgradeTruthEvidence,
  type TruthEvidence,
} from "@workspace/domain/truth";
import type { ScannerTruth } from "./scannerTruth";
import { normalizeChartTimeframe } from "./chartCandlesQuery";

// Two normal 15s polls. This limits the lifetime of the composed advice/news;
// it never substitutes snapshot build time for the underlying candle timestamp.
export const SYMBOL_TRUTH_MAX_AGE_MS = 30_000;
/** How long an EXPIRED read may still speak for the non-candle claims it
 * carries (the event-calendar state and the data timestamps). A 1m read
 * expires every bar close, well before the next poll can replace it; the
 * calendar state was not derived from that bar, so it is kept (as the server's
 * capExpiredTruthSnapshot keeps it) — but never beyond this bound, after which
 * the whole read is withdrawn and surfaces say event risk was not checked. */
export const SYMBOL_TRUTH_NEWS_MAX_AGE_MS = 120_000;
const DATA_STATE_RANK: Record<MarketTruthResponse["data"]["state"], number> = {
  UNAVAILABLE: 0, STALE: 1, SYNCING: 2, LIVE_CONFIRMED: 3,
};
const CAPPED_REASON ="The live feed isn't confirmed for this market right now, so there's no directional read to show.";
// Mirrors capExpiredTruthSnapshot on the server: an expired read is a closed
// bar / aged-out read, not a feed problem, so it must not be described as one.
const EXPIRED_COMPONENT_LABEL = "This read expired; waiting for current evidence.";
const EXPIRED_LEVELS_REASON = "The component evidence expired; waiting for a new read.";
const EXPIRED_HEADLINE = "This read expired; waiting for a new read on current evidence.";
const EXPIRED_ACTION_TEXT = "Watch only — the last read expired; waiting for a new read.";

function currentTimestamp(iso: string | null | undefined, nowMs: number): number | null {
  const stamp = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(stamp) && stamp <= nowMs ? stamp : null;
}

/** Newer servers expose the earliest component/bar deadline. It can only
 * shorten the existing client horizon; older responses retain the 30s cap.
 * A supplied but malformed deadline is not permission to keep advice alive. */
export function symbolTruthDeadline(snapshot: MarketTruthResponse | null): number | null {
  if (!snapshot) return null;
  const built = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(built)) return null;
  const localDeadline = built + SYMBOL_TRUTH_MAX_AGE_MS + 1;
  const supplied = (snapshot as MarketTruthResponse & { validUntil?: unknown }).validUntil;
  if (supplied == null) return localDeadline;
  const serverDeadline = typeof supplied === "string" ? Date.parse(supplied) : NaN;
  return Number.isFinite(serverDeadline) ? Math.min(localDeadline, serverDeadline) : built;
}

/** The next instant at which the resolved read changes: the advice deadline,
 * then the bound after which even the calendar state is withdrawn. */
export function symbolTruthRecheckAt(snapshot: MarketTruthResponse | null, nowMs: number): number | null {
  const deadline = symbolTruthDeadline(snapshot);
  if (deadline == null || nowMs < deadline) return deadline;
  return Date.parse(snapshot!.generatedAt) + SYMBOL_TRUTH_NEWS_MAX_AGE_MS + 1;
}

/**
 * Re-validate the server's per-claim evidence classes against the snapshot as
 * this client will display it (after any cap). Each claim keeps the WEAKER of
 * the server class and a local re-classification, so the client can only ever
 * downgrade. No server classification (older server) → null: nothing invented.
 */
export function capSymbolTruthEvidenceClasses(
  snapshot: MarketTruthResponse,
  nowMs: number,
): TruthEvidence | null {
  const local = classifyTruthEvidence({
    nowMs,
    data: snapshot.data,
    news: snapshot.news,
    components: snapshot.components,
    levels: snapshot.levels,
    verdict: snapshot.verdict,
  });
  return downgradeTruthEvidence(snapshot.evidence, local);
}

/** Returns the SAME object when the supplied classes already stand (or none
 * were supplied), so a confirmed read keeps referential identity. */
function withCappedClasses(snapshot: MarketTruthResponse, nowMs: number): MarketTruthResponse {
  if (snapshot.evidence === undefined) return snapshot;
  const evidence = capSymbolTruthEvidenceClasses(snapshot, nowMs);
  if (evidence == null) {
    const { evidence: _malformed, ...rest } = snapshot;
    void _malformed;
    return rest;
  }
  return JSON.stringify(evidence) === JSON.stringify(snapshot.evidence) ? snapshot : { ...snapshot, evidence };
}

/** Bind advice to the same confirmed chart evidence; this grants no execution authority. */
export function resolveSymbolTruthEvidence(input: {
  snapshot: MarketTruthResponse | null;
  symbol: string;
  apiTimeframe: string;
  scannerTruth: ScannerTruth | null;
  scannerLastCandleAt: string | null;
  scannerError: boolean;
  snapshotError: boolean;
  nowMs: number;
}): { snapshot: MarketTruthResponse | null; actionCapped: boolean } {
  const { snapshot, scannerTruth, nowMs } = input;
  if (!snapshot) return { snapshot: null, actionCapped: false };
  const generatedAt = currentTimestamp(snapshot.generatedAt, nowMs);
  // An error is a failed attempt to confirm this read. React Query retains the
  // old value, so explicitly withdraw it rather than displaying cached advice as current.
  if (input.snapshotError || !snapshot.data || !snapshot.verdict || !snapshot.components || !snapshot.levels ||
      snapshot.symbol !== input.symbol || snapshot.timeframe !== input.apiTimeframe ||
      generatedAt == null || nowMs - generatedAt > SYMBOL_TRUTH_NEWS_MAX_AGE_MS) {
    return { snapshot: null, actionCapped: true };
  }
  // Past the deadline (the server's validUntil — on 1m the close of the forming
  // bar — or the 30s local cap; a malformed supplied deadline counts as already
  // expired) the directional read is withdrawn exactly as the server's
  // capExpiredTruthSnapshot does, but the calendar state and data timestamps it
  // carries survive: they are not candle evidence. Expiry bypasses the
  // confirmed short-circuit, so an expired read can never render as confirmed.
  const expired = nowMs >= (symbolTruthDeadline(snapshot) ?? generatedAt);
  // Both sides are the newest CLOSED bar's close time (the snapshot's
  // data.lastCandleAt and the chart's own newest closed bar), never a forming
  // bar's scheduled close. Compare identity; do not mistake that boundary for
  // an observation timestamp. The scanner validates the actual candle open time.
  const snapshotCandleAt = snapshot.data.lastCandleAt ? Date.parse(snapshot.data.lastCandleAt) : NaN;
  const chartCandleAt = input.scannerLastCandleAt ? Date.parse(input.scannerLastCandleAt) : NaN;
  const confirmed = !input.scannerError && scannerTruth?.actionable === true &&
    scannerTruth.symbolInternal === input.symbol && normalizeChartTimeframe(scannerTruth.timeframe) === normalizeChartTimeframe(input.apiTimeframe) &&
    snapshot.data.state === "LIVE_CONFIRMED" &&
    snapshot.data.source != null && snapshot.data.source === scannerTruth.candles.source &&
    Number.isFinite(snapshotCandleAt) && snapshotCandleAt === chartCandleAt;
  if (confirmed && !expired) return { snapshot: withCappedClasses(snapshot, nowMs), actionCapped: false };

  // Only expiry withheld this read: say so, and keep the server's data state
  // (the feed was confirmed; nothing about it changed). Otherwise the feed is
  // the reason, and the chart's freshness verdict may only downgrade the state.
  const expiryOnly = confirmed && expired;
  const absent = () => ({ present: false, alignment: "UNKNOWN" as const,
    label: expiryOnly ? EXPIRED_COMPONENT_LABEL : "No confirmed read.", asOf: null });
  const components: MarketTruthResponse["components"] = {
    scanner: absent(), flame: absent(), timing: absent(), scalp: absent(),
  };
  const chartState = scannerTruth?.candles.status === "stale" ? "STALE" :
    scannerTruth?.candles.status === "unavailable" ? "UNAVAILABLE" : "SYNCING";
  // The cap may only downgrade: keep the server's state when it is already worse.
  const dataState = expiryOnly || DATA_STATE_RANK[snapshot.data.state] < DATA_STATE_RANK[chartState]
    ? snapshot.data.state : chartState;
  return {
    actionCapped: true,
    snapshot: withCappedClasses({
      ...snapshot,
      data: { ...snapshot.data, state: dataState },
      components,
      levels: { entryFrom: null, entryTo: null, stopLoss: null, invalidation: null, takeProfit: [],
        withheld: true, withheldReason: expiryOnly ? EXPIRED_LEVELS_REASON : CAPPED_REASON },
      verdict: {
        ...snapshot.verdict,
        bias: "UNKNOWN", stage: "UNKNOWN", headline: expiryOnly ? EXPIRED_HEADLINE : CAPPED_REASON,
        evidenceFor: [], evidenceAgainst: [], invalidation: null,
        bestAction: "WATCH_ONLY",
        bestActionText: expiryOnly ? EXPIRED_ACTION_TEXT : "Watch only — the live feed isn't confirmed for a live entry right now.",
      },
    }, nowMs),
  };
}
