// (N) News risk card — shown in Trade Plan Builder for the active plan's
// symbol. Displays risk label, time-until-event, warning text, AI summary,
// and a Run-scan button. Non-blocking by design: if NO_TRADE_WINDOW, the
// trade-plan checklist will surface a FAIL but this card alone does not
// stop the user from saving the plan (only the validate flow blocks).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type Risk = "CLEAR" | "CAUTION" | "HIGH_RISK" | "NO_TRADE_WINDOW";

interface NewsHeadline {
  headline: string;
  source: string | null;
  publishedAt: string | null;
  severity: "high" | "medium" | "low";
}

interface NewsContext {
  connected: boolean;
  provider: string;
  itemCount: number;
  highImpactCount: number;
  topHeadlines: NewsHeadline[];
  updatedAt: string | null;
}

export interface NewsRiskReport {
  id: number; symbol: string;
  relatedCurrency: string | null;
  eventId: number | null;
  riskLevel: Risk;
  timeUntilEventMinutes: number | null;
  tradeWarning: string | null;
  aiSummary: string;
  createdAt: string;
  news?: NewsContext | null;
}

// Severity badge tone for a surfaced driving headline.
const HEADLINE_SEVERITY_STYLE: Record<NewsHeadline["severity"], string> = {
  high:   "border-danger/40 text-danger",
  medium: "border-warning/40 text-warning",
  low:    "border-border text-txt-secondary",
};

// Honest relative age — "unknown" age never reads as fresh/fabricated.
function headlineAge(publishedAt: string | null): string {
  if (!publishedAt) return "time unknown";
  const ms = Date.now() - new Date(publishedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function HeadlineRow({ h }: { h: NewsHeadline }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5">
      <span className={`mt-0.5 shrink-0 rounded border px-1 py-0.5 text-[9px] uppercase ${HEADLINE_SEVERITY_STYLE[h.severity]}`}>
        {h.severity}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-foreground">{h.headline}</span>
        <span className="mt-0.5 block text-[10px] text-txt-muted">
          {h.source ?? "unknown source"} · {headlineAge(h.publishedAt)}
        </span>
      </span>
    </div>
  );
}

const STYLES: Record<Risk, string> = {
  CLEAR:            "bg-success/15 text-white",
  CAUTION:          "bg-warning/15 text-white",
  HIGH_RISK:        "bg-warning/15 text-white",
  NO_TRADE_WINDOW:  "bg-danger/15 text-white animate-pulse",
};

interface HeatDiagnosticsLite {
  providers: Array<{ kind: string; connected: boolean; name: string }>;
}

export function NewsRiskCard({ symbol }: { symbol: string | null }) {
  const qc = useQueryClient();
  const enabled = !!symbol;
  // Provider honesty: a green "CLEAR" must never imply a confident all-clear
  // when the economic-calendar / news providers are not connected. Reuse the
  // single market-heat provider-status seam (no second source of truth).
  const diagnostics = useQuery<HeatDiagnosticsLite>({
    queryKey: ["market-heat-diagnostics", "news-risk-card"],
    queryFn: async () => {
      const r = await fetch("/api/market-heat/diagnostics");
      if (!r.ok) throw new Error("Failed to load provider status");
      return r.json();
    },
    staleTime: 60_000,
    retry: false,
  });
  const calendarConnected =
    diagnostics.data?.providers.find((p) => p.kind === "calendar")?.connected ?? false;
  const newsConnected =
    diagnostics.data?.providers.find((p) => p.kind === "news")?.connected ?? false;
  const providersUnavailable = !calendarConnected && !newsConnected;
  const latest = useQuery<NewsRiskReport>({
    queryKey: ["news-risk-latest", symbol],
    queryFn: async () => {
      const r = await fetch(`/api/news-risk/latest?symbol=${encodeURIComponent(symbol!)}`);
      if (r.status === 404) throw new Error("no-report");
      if (!r.ok) throw new Error("Failed to load news risk report");
      return r.json();
    },
    enabled, retry: false,
  });
  const generate = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/news-risk/generate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      if (!r.ok) throw new Error("Failed to generate report");
      return r.json() as Promise<NewsRiskReport>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["news-risk-latest", symbol] }),
  });

  if (!symbol) {
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-txt-secondary">
        Set a symbol on the plan to enable news-risk analysis.
      </div>
    );
  }

  const r = latest.data;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4">
      <header className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">News & Economic Risk</h3>
          <p className="text-xs text-txt-muted">
            {symbol} · {r ? new Date(r.createdAt).toLocaleString() : "no report yet"}
          </p>
        </div>
        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary disabled:opacity-50"
        >
          {generate.isPending ? "Scanning…" : (r ? "Refresh scan" : "Run scan")}
        </button>
      </header>

      {providersUnavailable ? (
        <div className="rounded-md border border-border bg-muted/60 p-3 text-xs text-txt-secondary">
          <span className="font-semibold text-foreground">Provider unavailable.</span>{" "}
          No live news or economic-calendar provider is connected — risk is based
          on manually-synced events only. The absence of a warning is{" "}
          <span className="font-semibold">not an all-clear</span>.
        </div>
      ) : !calendarConnected ? (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-txt-secondary">
          Calendar unavailable — economic-calendar provider not connected.
          Scheduled-event risk is based on manually-synced events only.
          The absence of a warning is{" "}
          <span className="font-semibold">not an all-clear</span>.
        </div>
      ) : !newsConnected ? (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-txt-secondary">
          News unavailable — headline-news provider not connected.
          Breaking-news risk is not being monitored. The absence of a warning is{" "}
          <span className="font-semibold">not an all-clear</span>.
        </div>
      ) : null}

      {!r && !latest.isLoading && (
        <p className="text-sm text-txt-secondary">No report yet. Click "Run scan" — sync economic events first via the Calendar page if results look empty.</p>
      )}

      {r && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STYLES[r.riskLevel]}`}>
              {r.riskLevel.replace(/_/g, " ")}
            </span>
            {r.timeUntilEventMinutes !== null && (
              <span className="text-sm text-txt-secondary">
                Event {r.timeUntilEventMinutes >= 0
                  ? `in ${r.timeUntilEventMinutes}m`
                  : `${Math.abs(r.timeUntilEventMinutes)}m ago`}
              </span>
            )}
            {r.relatedCurrency && (
              <span className="text-sm text-txt-secondary">Currency: <span className="font-semibold text-foreground">{r.relatedCurrency}</span></span>
            )}
          </div>
          {r.tradeWarning && (
            <div className={`rounded-md border p-3 text-xs ${
              r.riskLevel === "NO_TRADE_WINDOW" ? "border-danger/40 bg-danger/40 text-danger"
              : r.riskLevel === "HIGH_RISK"     ? "border-warning/40 bg-warning/40 text-warning"
              : "border-warning/40 bg-warning/40 text-warning"
            }`}>
              <div className="mb-1 font-semibold uppercase tracking-wide">⚠ {r.riskLevel === "NO_TRADE_WINDOW" ? "Do not trade" : "Caution"}</div>
              <p>{r.tradeWarning}</p>
            </div>
          )}
          <p className="rounded-md border border-border bg-background/40 p-3 text-xs text-txt-secondary">
            {r.aiSummary}
          </p>
          {/* Driving headlines — the same severity-ranked headlines surfaced on
              the Global Market Heat card, shown only when risk is elevated/high
              and the news provider is positively connected. Honest-empty: a
              disconnected provider surfaces no headlines (never fabricated). */}
          {r.news?.connected &&
            r.riskLevel !== "CLEAR" &&
            r.news.topHeadlines.length > 0 && (
            <div className="space-y-1.5 rounded-md border border-border bg-background/40 p-3">
              <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-txt-muted">
                <span>Driving headlines</span>
                <span className="normal-case tracking-normal text-txt-muted">
                  {r.news.itemCount} item{r.news.itemCount === 1 ? "" : "s"} · {r.news.provider}
                </span>
                {r.news.highImpactCount > 0 && (
                  <span className="inline-flex items-center rounded-full border border-danger/40 px-1.5 py-0.5 text-[9px] normal-case tracking-normal text-danger">
                    {r.news.highImpactCount} high-impact
                  </span>
                )}
              </div>
              <div className="space-y-1">
                {r.news.topHeadlines.map((h, i) => (
                  <HeadlineRow key={`${h.headline}-${i}`} h={h} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
