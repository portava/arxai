import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Newspaper, AlertTriangle, ShieldAlert } from "lucide-react";
import { usePostMarketNewsIntelligence } from "@workspace/api-client-react";

interface Props {
  symbol: string;
  defaultOpen?: boolean;
}

const RISK_TONE: Record<string, string> = {
  none: "text-emerald-300",
  low: "text-emerald-300",
  medium: "text-amber-300",
  high: "text-orange-300",
  critical: "text-rose-300",
};

const REC_LABEL: Record<string, string> = {
  watch: "Watch",
  wait: "Wait",
  avoid: "Avoid",
  proceed_with_caution: "Proceed with caution",
};

const BIAS_TONE: Record<string, string> = {
  bullish: "text-emerald-300",
  bearish: "text-rose-300",
  mixed: "text-amber-300",
  unclear: "text-slate-400",
};

export function NewsRiskCheckPanel({ symbol, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const mut = usePostMarketNewsIntelligence();
  const trimmed = symbol.trim();

  useEffect(() => {
    if (!trimmed) return;
    mut.mutate({ data: { symbol: trimmed } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed]);

  const result = mut.data;
  const failed = mut.isError;
  const gateActive = result && (result.riskLevel === "high" || result.riskLevel === "critical" || result.riskLevel === "medium");

  return (
    <>
    {gateActive && (
      <div
        className={`rounded border p-2 text-xs flex items-start gap-1.5 ${
          result.riskLevel === "critical"
            ? "border-rose-600 bg-rose-950/40 text-rose-200"
            : result.riskLevel === "high"
            ? "border-orange-600 bg-orange-950/40 text-orange-200"
            : "border-amber-600 bg-amber-950/30 text-amber-200"
        }`}
        data-testid="news-risk-gate"
      >
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="space-y-0.5">
          <div className="font-semibold">
            {result.riskLevel === "critical"
              ? "News risk is critical. No trade right now."
              : result.riskLevel === "high"
              ? "News risk is high. Waiting may be safer."
              : "News risk is elevated. Confirm before acting."}
          </div>
          <div className="text-[11px] opacity-90">{result.warningSummary}</div>
        </div>
      </div>
    )}
    <div
      className="rounded border border-slate-700 bg-slate-900/50 p-2 text-xs"
      data-testid="news-risk-check-panel"
    >
      <button
        type="button"
        className="flex w-full items-center justify-between"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-1.5 text-slate-300">
          <Newspaper className="h-3 w-3" />
          News Risk Check
          {result && (
            <>
              <span className={`ml-1 font-semibold uppercase ${RISK_TONE[result.riskLevel]}`}>
                · {result.riskLevel}
              </span>
              <span className="ml-1 text-slate-500">
                ({REC_LABEL[result.recommendation] ?? result.recommendation})
              </span>
            </>
          )}
        </span>
        {open ? <ChevronDown className="h-3 w-3 text-slate-400" /> : <ChevronRight className="h-3 w-3 text-slate-400" />}
      </button>

      {open && (
        <div className="mt-2 space-y-1.5">
          {mut.isPending && !result && (
            <div className="text-slate-400">Checking news + event risk…</div>
          )}

          {failed && (
            <div className="flex items-start gap-1 text-amber-300">
              <AlertTriangle className="mt-0.5 h-3 w-3" />
              <span>News intelligence is temporarily unavailable.</span>
            </div>
          )}

          {result && (
            <>
              <div className="text-slate-300">{result.warningSummary}</div>

              <div className="grid grid-cols-3 gap-1 pt-1">
                <div className="rounded border border-slate-700 bg-slate-900 p-1">
                  <div className="text-[10px] text-slate-500">Bias</div>
                  <div className={`font-semibold ${BIAS_TONE[result.bias]}`}>
                    {result.bias}
                  </div>
                </div>
                <div className="rounded border border-slate-700 bg-slate-900 p-1">
                  <div className="text-[10px] text-slate-500">Timing</div>
                  <div className="font-mono text-slate-200">{result.timing}</div>
                </div>
                <div className="rounded border border-slate-700 bg-slate-900 p-1">
                  <div className="text-[10px] text-slate-500">Headlines</div>
                  <div className="font-mono text-slate-200">
                    {result.dataSources.headlines.connected
                      ? result.dataSources.headlines.count
                      : "—"}
                  </div>
                </div>
              </div>

              {result.upcomingEvent && (
                <div className="rounded border border-slate-700 bg-slate-900 p-1.5">
                  <div className="text-[10px] text-slate-500">Next event</div>
                  <div className="text-slate-200">
                    {result.upcomingEvent.title}{" "}
                    <span className="text-slate-500">
                      ({result.upcomingEvent.currency} · {result.upcomingEvent.impact})
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {result.upcomingEvent.minutesUntil >= 0
                      ? `in ${result.upcomingEvent.minutesUntil}m`
                      : `${Math.abs(result.upcomingEvent.minutesUntil)}m ago`}
                  </div>
                </div>
              )}

              {result.recentHeadlines.length > 0 && (
                <div className="space-y-0.5">
                  <div className="text-[10px] text-slate-500">Recent headlines</div>
                  {result.recentHeadlines.slice(0, 3).map((h, i) => (
                    <div key={i} className="text-[11px] text-slate-300 leading-snug">
                      · {h.headline}{" "}
                      <span className="text-slate-500">— {h.source}</span>
                    </div>
                  ))}
                </div>
              )}

              {!result.dataSources.headlines.connected && (
                <div className="text-[10px] text-slate-500">
                  News feed not configured — relying on scheduled-event risk only.
                </div>
              )}

              {!result.dataSources.calendar.connected && (
                <div className="text-[10px] text-slate-500">
                  Live economic-calendar provider not configured.
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
    </>
  );
}
