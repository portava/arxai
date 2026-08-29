import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Clock, AlertCircle } from "lucide-react";
import { usePostMarketHistoricalAnalysis } from "@workspace/api-client-react";

interface Props {
  symbol: string;
  timeframe?: string;
  defaultOpen?: boolean;
}

const WINDOW_LABEL: Record<string, string> = {
  yesterday: "Yesterday",
  lastWeek: "Last week",
  lastMonth: "Last month",
  lastYear: "Last year",
  fiveYearsAgo: "5 years ago",
};

const BIAS_TONE: Record<string, string> = {
  BULLISH: "text-success",
  BEARISH: "text-danger",
  MIXED: "text-warning",
  INSUFFICIENT_DATA: "text-txt-secondary",
};

export function HistoricalCheckPanel({ symbol, timeframe = "1d", defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const mut = usePostMarketHistoricalAnalysis();
  const trimmed = symbol.trim();

  useEffect(() => {
    if (!trimmed) return;
    mut.mutate({ data: { symbol: trimmed, timeframe } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, timeframe]);

  const result = mut.data;
  const failed = mut.isError;

  return (
    <div
      className="rounded border border-border bg-muted/50 p-2 text-xs"
      data-testid="historical-check-panel"
    >
      <button
        type="button"
        className="flex w-full items-center justify-between"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-1.5 text-txt-secondary">
          <Clock className="h-3 w-3" />
          Historical Check
          {result?.bias && (
            <span className={`ml-1 font-semibold ${BIAS_TONE[result.bias.label] ?? ""}`}>
              · {result.bias.label.replace("_", " ")}
            </span>
          )}
          {result?.bias?.confidence && (
            <span className="ml-1 text-txt-muted">
              ({result.bias.confidence.toLowerCase()} confidence · {result.bias.sampleSize}/5)
            </span>
          )}
        </span>
        {open ? <ChevronDown className="h-3 w-3 text-txt-secondary" /> : <ChevronRight className="h-3 w-3 text-txt-secondary" />}
      </button>

      {open && (
        <div className="mt-2 space-y-1.5">
          {mut.isPending && !result && (
            <div className="text-txt-secondary">Loading same-time comparison…</div>
          )}

          {failed && (
            <div className="flex items-start gap-1 text-warning">
              <AlertCircle className="mt-0.5 h-3 w-3" />
              <span>Historical data is temporarily unavailable.</span>
            </div>
          )}

          {result && (
            <>
              <div className="text-txt-secondary">{result.bias.explanation}</div>

              <div className="grid grid-cols-5 gap-1 pt-1">
                {result.windows.map((w) => (
                  <div
                    key={w.label}
                    className="rounded border border-border bg-card p-1 text-center"
                    title={w.unavailableReason ?? ""}
                  >
                    <div className="text-[10px] text-txt-muted">{WINDOW_LABEL[w.label] ?? w.label}</div>
                    {w.available && w.direction ? (
                      <div
                        className={`text-xs font-semibold ${
                          w.direction === "UP"
                            ? "text-success"
                            : w.direction === "DOWN"
                            ? "text-danger"
                            : "text-txt-secondary"
                        }`}
                      >
                        {w.direction === "UP" ? "▲" : w.direction === "DOWN" ? "▼" : "—"}
                        {w.changePct != null && (
                          <span className="ml-0.5 text-[10px] font-normal">
                            {w.changePct >= 0 ? "+" : ""}
                            {w.changePct.toFixed(2)}%
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="text-[10px] text-txt-muted">unavailable</div>
                    )}
                  </div>
                ))}
              </div>

              {result.setupSummary.sampleSize > 0 && (
                <div className="mt-1 grid grid-cols-4 gap-1 rounded border border-border bg-card p-1 text-[10px]">
                  <div>
                    <div className="text-txt-muted">Sample</div>
                    <div className="font-mono text-foreground">{result.setupSummary.sampleSize}/5</div>
                  </div>
                  <div>
                    <div className="text-txt-muted">Win rate</div>
                    <div className="font-mono text-foreground">
                      {result.setupSummary.winRate != null
                        ? `${result.setupSummary.winRate.toFixed(0)}%`
                        : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-txt-muted">Avg move</div>
                    <div className="font-mono text-foreground">
                      {result.setupSummary.avgMovePct != null
                        ? `${result.setupSummary.avgMovePct.toFixed(2)}%`
                        : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-txt-muted">Worst</div>
                    <div className="font-mono text-danger">
                      {result.setupSummary.worstDrawdownPct != null
                        ? `${result.setupSummary.worstDrawdownPct.toFixed(2)}%`
                        : "—"}
                    </div>
                  </div>
                </div>
              )}

              {result.dataQuality.coverageWarnings.length > 0 && (
                <div className="pt-1 text-[10px] text-txt-muted">
                  Some windows unavailable — bias is based on {result.bias.sampleSize} of 5 comparisons.
                </div>
              )}

              <div className="pt-1 text-[10px] text-txt-muted">
                Decision support only — not a buy or sell signal.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
