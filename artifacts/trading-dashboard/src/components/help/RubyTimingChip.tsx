// Ruby chat header timing chip — advisory, fail-open (renders nothing when the
// read cannot be shown honestly).
//
// It used to call the timing brain with no timeframe (server default M15),
// print "EURUSD · B · Wait" with no timeframe, poll every 90 s, and show a
// session/clock-only estimate (no current candles) as if it were a read of the
// chart — a read the Truth snapshot itself refuses.
//
// Same rules as the scanner chart-header ChartTimingChip:
//  - ask for the chart's own timeframe, and only when the timing route
//    supports it (anything else would be silently coerced to M15);
//  - render only when the server's echoed timeframe equals the one asked for;
//  - hide a session-only estimate (dataQuality.hasCandleData !== true);
//  - always print the timeframe; mark partial data; refresh every 30 s.

import {
  useGetTimingBrain,
  getGetTimingBrainQueryKey,
  type GetTimingBrainParams,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { toApiTimeframe } from "@/lib/chartCandlesQuery";
import { isTimingChipTimeframe, timingTimeframeLabel } from "@/components/scanner/ChartTimingChip";

const TIMING_CHIP_COLOR: Record<string, string> = {
  "A+": "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  "A":  "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  "B":  "border-blue-500/40 bg-blue-500/10 text-blue-400",
  "C":  "border-amber-500/40 bg-amber-500/10 text-amber-400",
  "D":  "border-orange-500/40 bg-orange-500/10 text-orange-400",
  "F":  "border-rose-500/40 bg-rose-500/10 text-rose-400",
};

const PERM_LABEL: Record<string, string> = {
  GO: "GO", WAIT_FOR_ENTRY: "Wait", WAIT_NEWS: "News", NO_TRADE: "Skip", STAND_DOWN: "Stand down",
};

/**
 * @param symbol         the chart symbol
 * @param chartTimeframe the chart's timeframe id as the scanner stores it (e.g. "1h")
 */
export function RubyTimingChip({ symbol, chartTimeframe }: { symbol: string; chartTimeframe: string | null }) {
  const apiTf = chartTimeframe ? toApiTimeframe(chartTimeframe) : "";
  if (!isTimingChipTimeframe(apiTf)) return null;
  return <SupportedRubyTimingChip symbol={symbol} apiTf={apiTf} />;
}

function SupportedRubyTimingChip({
  symbol,
  apiTf,
}: {
  symbol: string;
  apiTf: NonNullable<GetTimingBrainParams["timeframe"]>;
}) {
  const params: GetTimingBrainParams = { timeframe: apiTf };
  const q = useGetTimingBrain(symbol, params, {
    query: {
      queryKey: getGetTimingBrainQueryKey(symbol, params),
      refetchInterval: 30_000,
      retry: false,
      staleTime: 20_000,
    },
  });
  const r = q.data as
    | {
        timeframe?: string;
        timingGrade?: string;
        entryPermission?: string;
        dataQuality?: { label?: string; hasCandleData?: boolean; note?: string } | null;
      }
    | undefined;
  if (!r?.timingGrade || !r.entryPermission) return null;
  // The server's echo is the authority on which timeframe this grade is for.
  if (r.timeframe !== apiTf) return null;
  // A session-only estimate is not a read of this chart's candles.
  if (r.dataQuality?.hasCandleData !== true) return null;
  const tfLabel = timingTimeframeLabel(apiTf) ?? apiTf;
  const partial = r.dataQuality?.label !== "real";
  const colorClass = TIMING_CHIP_COLOR[r.timingGrade] ?? "border-zinc-500/40 bg-zinc-500/10 text-zinc-400";
  const perm = PERM_LABEL[r.entryPermission] ?? r.entryPermission;
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-bold leading-none", colorClass)}
      title={`${symbol} ${tfLabel} timing: ${r.timingGrade} grade · ${r.entryPermission} — computed on ${tfLabel} candles${partial ? ` (${r.dataQuality?.note || "partial data"})` : ""}; advisory only`}
      data-testid="ruby-timing-chip"
    >
      {symbol} · {tfLabel} · {r.timingGrade} · {perm}{partial ? " · partial" : ""}
    </span>
  );
}
