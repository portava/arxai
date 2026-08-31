import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Newspaper, AlertTriangle, ShieldAlert } from "lucide-react";
import { usePostMarketNewsIntelligence } from "@workspace/api-client-react";

interface Props {
  symbol: string;
  defaultOpen?: boolean;
}

const RISK_TONE: Record<string, string> = {
  none: "text-success",
  low: "text-success",
  medium: "text-warning",
  high: "text-warning",
  critical: "text-danger",
};

const REC_LABEL: Record<string, string> = {
  watch: "Watch",
  wait: "Wait",
  avoid: "Avoid",
  proceed_with_caution: "Proceed with caution",
};

const BIAS_TONE: Record<string, string> = {
  bullish: "text-success",
  bearish: "text-danger",
  mixed: "text-warning",
  unclear: "text-txt-secondary",
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
  // Honest-blindness: a "none" risk read with the economic-calendar feed
  // disconnected means the system cannot see scheduled events at all — the
  // collapsed header must read a muted "unknown", never a green "none" (a
  // real high-impact event could be minutes away).
  const calendarBlind = Boolean(
    result && !result.dataSources.calendar.connected && result.riskLevel === "none",
  );

  return (
    <>
    {gateActive && (
      <div
        className={`rounded border p-2 text-xs flex items-start gap-1.5 ${
          result.riskLevel === "critical"
            ? "border-danger bg-danger/40 text-danger"
            : result.riskLevel === "high"
            ? "border-warning bg-warning/40 text-warning"
            : "border-warning bg-warning/30 text-warning"
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
      className="rounded border border-border bg-muted/50 p-2 text-xs"
      data-testid="news-risk-check-panel"
    >
      <button
        type="button"
        className="flex w-full items-center justify-between"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-1.5 text-txt-secondary">
          <Newspaper className="h-3 w-3" />
          News Risk Check
          {result && (
            <>
              <span
                className={`ml-1 font-semibold uppercase ${calendarBlind ? "text-txt-muted" : RISK_TONE[result.riskLevel]}`}
                data-testid="news-risk-level-badge"
              >
                · {calendarBlind ? "unknown" : result.riskLevel}
              </span>
              <span className="ml-1 text-txt-muted">
                {calendarBlind
                  ? "(calendar feed unavailable)"
                  : `(${REC_LABEL[result.recommendation] ?? result.recommendation})`}
              </span>
            </>
          )}
        </span>
        {open ? <ChevronDown className="h-3 w-3 text-txt-secondary" /> : <ChevronRight className="h-3 w-3 text-txt-secondary" />}
      </button>

      {open && (
        <div className="mt-2 space-y-1.5">
          {mut.isPending && !result && (
            <div className="text-txt-secondary">Checking news + event risk…</div>
          )}

          {failed && (
            <div className="flex items-start gap-1 text-warning">
              <AlertTriangle className="mt-0.5 h-3 w-3" />
              <span>News intelligence is temporarily unavailable.</span>
            </div>
          )}

          {result && (
            <>
              <div className="text-txt-secondary">{result.warningSummary}</div>

              <div className="grid grid-cols-3 gap-1 pt-1">
                <div className="rounded border border-border bg-card p-1">
                  <div className="text-[10px] text-txt-muted">Bias</div>
                  <div className={`font-semibold ${BIAS_TONE[result.bias]}`}>
                    {result.bias}
                  </div>
                </div>
                <div className="rounded border border-border bg-card p-1">
                  <div className="text-[10px] text-txt-muted">Timing</div>
                  <div className="font-mono text-foreground">{result.timing}</div>
                </div>
                <div className="rounded border border-border bg-card p-1">
                  <div className="text-[10px] text-txt-muted">Headlines</div>
                  <div className="font-mono text-foreground">
                    {result.dataSources.headlines.connected
                      ? result.dataSources.headlines.count
                      : "—"}
                  </div>
                </div>
              </div>

              {result.upcomingEvent && (
                <div className="rounded border border-border bg-card p-1.5">
                  <div className="text-[10px] text-txt-muted">Next event</div>
                  <div className="text-foreground">
                    {result.upcomingEvent.title}{" "}
                    <span className="text-txt-muted">
                      ({result.upcomingEvent.currency} · {result.upcomingEvent.impact})
                    </span>
                  </div>
                  <div className="text-[10px] text-txt-muted">
                    {result.upcomingEvent.minutesUntil >= 0
                      ? `in ${result.upcomingEvent.minutesUntil}m`
                      : `${Math.abs(result.upcomingEvent.minutesUntil)}m ago`}
                  </div>
                </div>
              )}

              {result.recentHeadlines.length > 0 && (
                <div className="space-y-0.5">
                  <div className="text-[10px] text-txt-muted">Recent headlines</div>
                  {result.recentHeadlines.slice(0, 3).map((h, i) => (
                    <div key={i} className="text-[11px] text-txt-secondary leading-snug">
                      · {h.headline}{" "}
                      <span className="text-txt-muted">— {h.source}</span>
                    </div>
                  ))}
                </div>
              )}

              {!result.dataSources.headlines.connected && (
                <div className="text-[10px] text-txt-muted">
                  News feed not configured — relying on scheduled-event risk only.
                </div>
              )}

              {!result.dataSources.calendar.connected && (
                <div className="flex items-start gap-1 text-warning" data-testid="news-risk-calendar-blind">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="text-[11px]">
                    Scheduled-event risk is unknown — {result.dataSources.calendar.note}
                  </span>
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
    </>
  );
}
