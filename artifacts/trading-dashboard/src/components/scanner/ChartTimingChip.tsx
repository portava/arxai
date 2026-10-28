// Chart-header timing chip (Phase 3 timing overlay — advisory, fail-open).
//
// Owner screenshot 2026-10-27: the 1m V75 chart header showed "D · WAIT FOR
// ENTRY" with no timeframe. The chip called the timing brain without a
// timeframe, so the route defaulted to M15 and an M15 grade sat on a 1m chart
// whose every other label is computed on M1.
//
// Truth rules:
//  - Ask for the CHART's own timeframe, and only when the timing route supports
//    it (M1/M5/M15/M30/H1/H4/D1). Anything else (2m, 8h, 1W, …) would be
//    silently coerced to M15 server-side, so the chip is not mounted at all.
//  - Render only when the server's echoed `timeframe` equals the one asked for
//    (downgrade-only: a fallback read is hidden, never relabelled).
//  - Hide a session-only estimate (no candle data): that grade is not a read of
//    this chart.
//  - Always print the timeframe the grade belongs to.
//  - Show a grade only while a CURRENT read backs it: not after a failed
//    refetch (React Query keeps the last data), not once the read is older than
//    TIMING_CHIP_MAX_AGE_MS (e.g. the tab slept and polling paused), not with a
//    missing / malformed / future generatedAt, and not while the chart's own
//    scanner-truth gate is downgraded (stale / delayed / unconfirmed feed).

import { Flame } from "lucide-react";
import {
  useGetTimingBrain,
  getGetTimingBrainQueryKey,
  type GetTimingBrainParams,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useScannerReadGate } from "@/hooks/useScannerReadGate";
import { useEvidenceDeadline } from "@/hooks/useEvidenceDeadline";

// Oldest timing read the chip will still show. A healthy poll keeps the read
// within the server's 15s timing-read cache + the chip's 30s refetch interval
// + request latency; anything older means refetches failed or were paused.
const TIMING_CHIP_MAX_AGE_MS = 60_000;
// A generatedAt later than now by more than this is not a usable build time.
const FUTURE_SKEW_MS = 5_000;

// The timing route's timeframe enum (GetTimingBrainTimeframe). Spelled out so a
// unit test's module mock cannot empty it; the type keeps it in lock-step.
const SUPPORTED_LIST: ReadonlyArray<NonNullable<GetTimingBrainParams["timeframe"]>> = [
  "M1", "M5", "M15", "M30", "H1", "H4", "D1",
];
const SUPPORTED = new Set<string>(SUPPORTED_LIST);

export function isTimingChipTimeframe(apiTf: string): apiTf is NonNullable<GetTimingBrainParams["timeframe"]> {
  return SUPPORTED.has(apiTf);
}

const TF_LABEL: Record<string, string> = {
  M1: "1m", M5: "5m", M15: "15m", M30: "30m", H1: "1h", H4: "4h", D1: "1D",
};

/** Pill-style label for a timing-brain timeframe echo ("M15" → "15m"); unknown → raw. */
export function timingTimeframeLabel(code: string | null | undefined): string | null {
  const c = (code ?? "").trim();
  if (!c) return null;
  return TF_LABEL[c.toUpperCase()] ?? c;
}

const PERM_COLOR: Record<string, string> = {
  GO: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  WAIT_FOR_ENTRY: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  WAIT_NEWS: "border-orange-500/40 bg-orange-500/10 text-orange-400",
  NO_TRADE: "border-rose-500/40 bg-rose-500/10 text-rose-400",
  STAND_DOWN: "border-rose-600/50 bg-rose-600/15 text-rose-300",
};

function permissionWords(p: string): string {
  const s = p.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * @param apiTf          the chart's canonical timeframe (e.g. "M1")
 * @param timeframeLabel the chart pill label for the same timeframe (e.g. "1m")
 */
export function ChartTimingChip({
  symbol,
  apiTf,
  timeframeLabel,
}: {
  symbol: string;
  apiTf: string;
  timeframeLabel: string;
}) {
  if (!isTimingChipTimeframe(apiTf)) return null;
  return <SupportedTimingChip symbol={symbol} apiTf={apiTf} timeframeLabel={timeframeLabel} />;
}

function SupportedTimingChip({
  symbol,
  apiTf,
  timeframeLabel,
}: {
  symbol: string;
  apiTf: NonNullable<GetTimingBrainParams["timeframe"]>;
  timeframeLabel: string;
}) {
  const params: GetTimingBrainParams = { timeframe: apiTf };
  const q = useGetTimingBrain(symbol, params, {
    query: { queryKey: getGetTimingBrainQueryKey(symbol, params), refetchInterval: 30_000, staleTime: 20_000 },
  });
  const gate = useScannerReadGate(symbol, timeframeLabel);
  const read = q.data as
    | {
        generatedAt?: string;
        timeframe?: string;
        timingGrade?: string;
        entryPermission?: string;
        heatScore?: number;
        dataQuality?: { hasCandleData?: boolean } | null;
      }
    | undefined;
  const builtAt = typeof read?.generatedAt === "string" ? Date.parse(read.generatedAt) : NaN;
  const nowMs = useEvidenceDeadline(Number.isFinite(builtAt) ? builtAt + TIMING_CHIP_MAX_AGE_MS : null);
  if (!read?.timingGrade || !read.entryPermission) return null;
  // The server's echo is the authority on which timeframe this grade is for.
  if (read.timeframe !== apiTf) return null;
  // A session-only estimate is not a read of this chart's candles.
  if (read.dataQuality?.hasCandleData !== true) return null;
  // The chart's feed is not confirmed: no timing grade over it (the chart
  // header already states the feed condition).
  if (gate.downgraded) return null;
  const current =
    !q.isError &&
    Number.isFinite(builtAt) &&
    builtAt <= nowMs + FUTURE_SKEW_MS &&
    nowMs - builtAt < TIMING_CHIP_MAX_AGE_MS;
  if (!current) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-border text-[10px] text-txt-muted"
        title={
          q.isError
            ? `The ${timeframeLabel} timing read could not be refreshed — no grade is shown until a current read arrives.`
            : `The last ${timeframeLabel} timing read is not current — no grade is shown until a fresh read arrives.`
        }
        data-testid="scanner-chart-timing-chip-unavailable"
      >
        <Flame className="h-2.5 w-2.5" />
        {timeframeLabel} timing · no current read
      </Badge>
    );
  }
  const perm = permissionWords(read.entryPermission);
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 text-[10px]", PERM_COLOR[read.entryPermission] ?? "border-border text-txt-muted")}
      title={`${timeframeLabel} timing grade ${read.timingGrade} · ${perm} (heat ${read.heatScore ?? "?"}) — computed on ${timeframeLabel} candles; advisory only`}
      data-testid="scanner-chart-timing-chip"
    >
      <Flame className="h-2.5 w-2.5" />
      {timeframeLabel} timing · {read.timingGrade} · {perm}
    </Badge>
  );
}
