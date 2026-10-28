// Ruby chat header timing chip — advisory. It shows a grade only while a
// current read of the chart's own candles backs it; otherwise it renders
// nothing, or "no current read" when an old grade exists.
//
// It used to call the timing brain with no timeframe (server default M15),
// print "EURUSD · B · Wait" with no timeframe, poll every 90 s, and show a
// session/clock-only estimate (no current candles) as if it were a read of the
// chart — a read the Truth snapshot itself refuses.
//
// Same rules as the scanner chart-header ChartTimingChip — literally: both
// chips read through useTimingChipRead, so on the same screen they make one
// request (timeframe + tz: one query, one server cache entry) and apply the
// same checks:
//  - ask for the chart's own timeframe, and only when the timing route
//    supports it (anything else would be silently coerced to M15);
//  - render only when the server's echoed timeframe equals the one asked for;
//  - hide a session-only estimate (dataQuality.hasCandleData !== true);
//  - hide the grade while the chart's scanner-truth feed gate is downgraded;
//  - no grade without a current read: not after a failed refetch (React Query
//    keeps the old data), not past the 30 s advice lifetime, not with a
//    missing or future generatedAt — the chip then says "no current read";
//  - always print the timeframe; mark partial data; refresh every 30 s.

import { cn } from "@/lib/utils";
import { toApiTimeframe } from "@/lib/chartCandlesQuery";
import {
  isTimingChipTimeframe,
  timingTimeframeLabel,
  useTimingChipRead,
} from "@/components/scanner/ChartTimingChip";
import type { GetTimingBrainParams } from "@workspace/api-client-react";

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
  if (!chartTimeframe || !isTimingChipTimeframe(apiTf)) return null;
  return <SupportedRubyTimingChip symbol={symbol} apiTf={apiTf} chartTimeframe={chartTimeframe} />;
}

function SupportedRubyTimingChip({
  symbol,
  apiTf,
  chartTimeframe,
}: {
  symbol: string;
  apiTf: NonNullable<GetTimingBrainParams["timeframe"]>;
  chartTimeframe: string;
}) {
  const state = useTimingChipRead(symbol, apiTf, chartTimeframe);
  if (state.kind === "hidden") return null;
  const tfLabel = timingTimeframeLabel(apiTf) ?? apiTf;
  if (state.kind === "not_current") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-zinc-500/40 bg-zinc-500/10 px-1.5 py-0.5 text-[9px] font-bold leading-none text-zinc-400"
        title={
          state.isError
            ? `The ${symbol} ${tfLabel} timing read could not be refreshed — no grade is shown until a current read arrives.`
            : `The last ${symbol} ${tfLabel} timing read is not current — no grade is shown until a fresh read arrives.`
        }
        data-testid="ruby-timing-chip-unavailable"
      >
        {symbol} · {tfLabel} · no current read
      </span>
    );
  }
  const r = state.read;
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
