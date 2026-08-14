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
  BULLISH: "text-emerald-300",
  BEARISH: "text-rose-300",
  MIXED: "text-amber-300",
  INSUFFICIENT_DATA: "text-slate-400",
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
      className="rounded border border-slate-700 bg-slate-900/50 p-2 text-xs"
      data-testid="historical-check-panel"
    >
      <button
        type="button"
        className="flex w-full items-center justify-between"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-1.5 text-slate-300">
          <Clock className="h-3 w-3" />
          Historical Check
          {result?.bias && (
            <span className={`ml-1 font-semibold ${BIAS_TONE[result.bias.label] ?? ""}`}>
              · {result.bias.label.replace("_", " ")}
            </span>
          )}
          {result?.bias?.confidence && (
            <span className="ml-1 text-slate-500">
              ({result.bias.confidence.toLowerCase()} confidence · {result.bias.sampleSize}/5)
            </span>
          )}
        </span>
        {open ? <ChevronDown className="h-3 w-3 text-slate-400" /> : <ChevronRight className="h-3 w-3 text-slate-400" />}
      </button>

      {open && (
        <div className="mt-2 space-y-1.5">
          {mut.isPending && !result && (
            <div className="text-slate-400">Loading same-time comparison…</div>
          )}

          {failed && (
            <div className="flex items-start gap-1 text-amber-300">
              <AlertCircle className="mt-0.5 h-3 w-3" />
              <span>Historical data is temporarily unavailable.</span>
            </div>
          )}

          {result && (
            <>
              <div className="text-slate-400">{result.bias.explanation}</div>

              <div className="grid grid-cols-5 gap-1 pt-1">
                {result.windows.map((w) => (
                  <div
                    key={w.label}
                    className="rounded border border-slate-700 bg-slate-900 p-1 text-center"
                    title={w.unavailableReason ?? ""}
                  >
                    <div className="text-[10px] text-slate-500">{WINDOW_LABEL[w.label] ?? w.label}</div>
                    {w.available && w.direction ? (
                      <div
                        className={`text-xs font-semibold ${
                          w.direction === "UP"
                            ? "text-emerald-300"
                            : w.direction === "DOWN"
                            ? "text-rose-300"
                            : "text-slate-300"
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
                      <div className="text-[10px] text-slate-500">unavailable</div>
                    )}
                  </div>
                ))}
              </div>

              {result.setupSummary.sampleSize > 0 && (
                <div className="mt-1 grid grid-cols-4 gap-1 rounded border border-slate-700 bg-slate-900 p-1 text-[10px]">
                  <div>
                    <div className="text-slate-500">Sample</div>
                    <div className="font-mono text-slate-200">{result.setupSummary.sampleSize}/5</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Win rate</div>
                    <div className="font-mono text-slate-200">
                      {result.setupSummary.winRate != null
                        ? `${result.setupSummary.winRate.toFixed(0)}%`
                        : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">Avg move</div>
                    <div className="font-mono text-slate-200">
                      {result.setupSummary.avgMovePct != null
                        ? `${result.setupSummary.avgMovePct.toFixed(2)}%`
                        : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">Worst</div>
                    <div className="font-mono text-rose-300">
                      {result.setupSummary.worstDrawdownPct != null
                        ? `${result.setupSummary.worstDrawdownPct.toFixed(2)}%`
                        : "—"}
                    </div>
                  </div>
                </div>
              )}

              {result.dataQuality.coverageWarnings.length > 0 && (
                <div className="pt-1 text-[10px] text-slate-500">
                  Some windows unavailable — bias is based on {result.bias.sampleSize} of 5 comparisons.
                </div>
              )}

              <div className="pt-1 text-[10px] text-slate-500">
                Decision support only — not a buy or sell signal.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
