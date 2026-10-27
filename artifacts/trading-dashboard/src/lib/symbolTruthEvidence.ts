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
const CAPPED_REASON = "The live feed isn't confirmed for this market right now, so there's no directional read to show.";

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
      generatedAt == null || nowMs >= (symbolTruthDeadline(snapshot) ?? generatedAt)) {
    return { snapshot: null, actionCapped: true };
  }
  // ChartDataService exposes closeTime here, which may be the scheduled end of
  // a forming candle. Compare identity; do not mistake that boundary for an
  // observation timestamp. The scanner validates the actual candle open time.
  const snapshotCandleAt = snapshot.data.lastCandleAt ? Date.parse(snapshot.data.lastCandleAt) : NaN;
  const chartCandleAt = input.scannerLastCandleAt ? Date.parse(input.scannerLastCandleAt) : NaN;
  const confirmed = !input.scannerError && scannerTruth?.actionable === true &&
    scannerTruth.symbolInternal === input.symbol && normalizeChartTimeframe(scannerTruth.timeframe) === normalizeChartTimeframe(input.apiTimeframe) &&
    snapshot.data.state === "LIVE_CONFIRMED" &&
    snapshot.data.source != null && snapshot.data.source === scannerTruth.candles.source &&
    Number.isFinite(snapshotCandleAt) && snapshotCandleAt === chartCandleAt;
  if (confirmed) return { snapshot: withCappedClasses(snapshot, nowMs), actionCapped: false };

  const absent = () => ({ present: false, alignment: "UNKNOWN" as const, label: "No confirmed read.", asOf: null });
  const components: MarketTruthResponse["components"] = {
    scanner: absent(), flame: absent(), timing: absent(), scalp: absent(),
  };
  const dataState = scannerTruth?.candles.status === "stale" ? "STALE" :
    scannerTruth?.candles.status === "unavailable" ? "UNAVAILABLE" : "SYNCING";
  return {
    actionCapped: true,
    snapshot: withCappedClasses({
      ...snapshot,
      data: { ...snapshot.data, state: dataState },
      components,
      levels: { entryFrom: null, entryTo: null, stopLoss: null, invalidation: null, takeProfit: [],
        withheld: true, withheldReason: CAPPED_REASON },
      verdict: {
        ...snapshot.verdict,
        bias: "UNKNOWN", stage: "UNKNOWN", headline: CAPPED_REASON,
        evidenceFor: [], evidenceAgainst: [], invalidation: null,
        bestAction: "WATCH_ONLY",
        bestActionText: "Watch only — the live feed isn't confirmed for a live entry right now.",
      },
    }, nowMs),
  };
}
