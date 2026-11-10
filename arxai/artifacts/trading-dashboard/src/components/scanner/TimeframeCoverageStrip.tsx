// Per-timeframe coverage for the scanner page.
//
// The scanner reads every chart timeframe M1..D1. For each (symbol,
// timeframe) the server sends one coverage entry: its own reading, or — when
// that timeframe has no signal, too little data, or was skipped by the
// per-cycle scan budget — the nearest HIGHER timeframe's reading, flagged
// `fallback: true` with a label. This strip shows those fallbacks and gaps
// plainly; it never presents a fallback as the timeframe's own reading.

export interface TimeframeCoverageEntry {
  symbol: string;
  timeframe: string;
  status: "signal" | "no_signal" | "insufficient_data" | "skipped_budget";
  readingTimeframe: string | null;
  fallback: boolean;
  label: string;
}

/** Ranking basis the server stamps on every row (three-tier measured ranking). */
export type RankBasis = "calibrated_probability" | "measured_base_rate" | "unmeasured_raw_order";

export const UNMEASURED_RANK_TEXT = "unmeasured, ranked by raw score";

/** Short visible text for a row's ranking basis. Never calls the raw score a probability. */
export function rankBasisText(basis: RankBasis | string | null | undefined, label?: string | null): string {
  if (label) return label;
  if (basis === "calibrated_probability") return "ranked by calibrated probability";
  if (basis === "measured_base_rate") return "ranked by measured base rate";
  return UNMEASURED_RANK_TEXT;
}

/** Coverage entry for one row's own slot, if the server sent one. */
export function coverageFor(
  coverage: readonly TimeframeCoverageEntry[] | null | undefined,
  symbol: string,
  timeframe: string,
): TimeframeCoverageEntry | null {
  return coverage?.find((c) => c.symbol === symbol && c.timeframe === timeframe) ?? null;
}

/** Entries that need saying: fallbacks and slots with no reading at all. */
export function coverageGaps(coverage: readonly TimeframeCoverageEntry[] | null | undefined): TimeframeCoverageEntry[] {
  return (coverage ?? []).filter((c) => c.status !== "signal");
}

export function TimeframeCoverageStrip({
  coverage,
  skippedPairs = 0,
}: {
  coverage: readonly TimeframeCoverageEntry[] | null | undefined;
  skippedPairs?: number;
}) {
  const gaps = coverageGaps(coverage);
  if (!coverage || coverage.length === 0) return null;
  const tfs = [...new Set(coverage.map((c) => c.timeframe))];
  return (
    <div className="rounded border p-2 text-xs space-y-1" data-testid="scanner-timeframe-coverage">
      <div className="text-muted-foreground">
        Timeframes scanned: {tfs.join(", ")}.
        {skippedPairs > 0 && (
          <span data-testid="scanner-timeframe-budget-note">
            {" "}{skippedPairs} market/timeframe pair(s) were left out of this cycle by the scan budget.
          </span>
        )}
      </div>
      {gaps.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            {gaps.filter((g) => g.fallback).length} higher-timeframe fallback(s), {gaps.filter((g) => !g.fallback).length} slot(s) with no reading
          </summary>
          <ul className="mt-1 space-y-0.5">
            {gaps.map((g) => (
              <li
                key={`${g.symbol}-${g.timeframe}`}
                data-testid={`scanner-coverage-${g.symbol}-${g.timeframe}`}
                data-fallback={g.fallback ? "true" : "false"}
              >
                <span className="font-medium">{g.symbol}</span> {g.label}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
