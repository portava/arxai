// Timing Intelligence card — surfaces Ruby's Market Timing Brain read for the
// active chart symbol on the Scanner page (Task #224).
//
// SAFETY: reads ONLY the read-only `GET /api/me/timing-brain/:symbol`
// advisory endpoint. It is ADVISORY ONLY — it never places, modifies, or
// closes a trade, and never gates execution. It renders exactly what the
// backend returns; when data quality is "unavailable" it collapses to an
// honest "not enough data" state and never fabricates scores or levels.

import { useEffect, useMemo, useState } from "react";
import {
  Gauge,
  Loader2,
  ChevronDown,
  RefreshCw,
  Clock,
  AlertTriangle,
  Flame,
  Activity,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ScannerReadGate } from "@/components/scanner/ScannerReadGate";
import { useScannerReadGate } from "@/hooks/useScannerReadGate";
import { useScannerTimeframe } from "@/hooks/useScannerTimeframe";
import { useSymbolTruth } from "@/hooks/useSymbolTruth";
import {
  useGetTimingBrain,
  getGetTimingBrainQueryKey,
  type MarketTimingRead,
} from "@workspace/api-client-react";
import { useAssistantName } from "@/lib/assistant-name";

// ── Label + colour maps (never leak raw UPPER_SNAKE tokens to users) ─────────

const GRADE_COLORS: Record<string, string> = {
  "A+": "bg-success/10 text-success border-success/25",
  A: "bg-success/10 text-success border-success/25",
  B: "bg-primary/10 text-primary border-primary/25",
  C: "bg-warning/10 text-warning border-warning/25",
  D: "bg-warning/10 text-warning border-warning/25",
  F: "bg-danger/10 text-danger border-danger/25",
};

const PERMISSION_COLORS: Record<string, string> = {
  GO: "bg-success/10 text-success border-success/25",
  WAIT_FOR_ENTRY: "bg-warning/10 text-warning border-warning/25",
  WAIT_NEWS: "bg-warning/10 text-warning border-warning/25",
  NO_TRADE: "bg-muted/60 text-muted-foreground border-border",
  STAND_DOWN: "bg-danger/10 text-danger border-danger/25",
};

const PERMISSION_LABELS: Record<string, string> = {
  GO: "Go",
  WAIT_FOR_ENTRY: "Wait for entry",
  WAIT_NEWS: "Wait — news",
  NO_TRADE: "No trade",
  STAND_DOWN: "Stand down",
};

const ACTION_LABELS: Record<string, string> = {
  BUY: "Buy",
  SELL: "Sell",
  WAIT_FOR_PULLBACK: "Wait for pullback",
  WAIT_FOR_NEWS: "Wait for news",
  WAIT_BETTER_TIMING: "Wait for better timing",
  STAND_DOWN: "Stand down",
  WATCH_ONLY: "Watch only",
};

const QUALITY_NOTE: Record<string, { text: string; tone: string }> = {
  real: { text: "Live data", tone: "text-success" },
  partial: { text: "Partial data", tone: "text-warning" },
  basic_timing_estimate: { text: "Timing estimate", tone: "text-warning" },
  unavailable: { text: "Unavailable", tone: "text-txt-muted" },
};

function humanize(map: Record<string, string>, raw: string | null | undefined): string {
  if (!raw) return "—";
  return map[String(raw).toUpperCase()] ?? String(raw);
}

// Live "updated Xs ago" timer from generatedAt against a ticking now.
function ageLabel(generatedAt: string | null | undefined, nowTs: number): string {
  if (!generatedAt) return "—";
  const t = Date.parse(generatedAt);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((nowTs - t) / 1000));
  if (s < 60) return `updated ${s}s ago`;
  const m = Math.floor(s / 60);
  return `updated ${m}m ${s % 60}s ago`;
}

function userTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function ScorePill({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number;
  tone: "good" | "bad";
  icon?: React.ReactNode;
}) {
  const color =
    tone === "good"
      ? value >= 65
        ? "text-success"
        : value >= 45
          ? "text-warning"
          : "text-muted-foreground"
      : value >= 65
        ? "text-danger"
        : value >= 45
          ? "text-warning"
          : "text-muted-foreground";
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-background/40 px-2.5 py-1.5">
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-txt-muted leading-none">
        {icon}
        {label}
      </span>
      <span className={cn("font-mono text-sm font-semibold leading-none", color)}>
        {Math.round(value)}
        <span className="text-[10px] font-normal text-txt-muted">/100</span>
      </span>
    </div>
  );
}

export function TimingIntelligenceCard({ symbol }: { symbol: string }) {
  const [open, setOpen] = useState(true);
  const { name } = useAssistantName();
  const tz = useMemo(() => userTimezone(), []);

  const params = useMemo(() => (tz ? { tz } : undefined), [tz]);

  const { data, isLoading, isFetching, isError, refetch } = useGetTimingBrain(
    symbol,
    params,
    {
      query: {
        queryKey: getGetTimingBrainQueryKey(symbol, params),
        enabled: !!symbol && open,
        // Advisory context — poll gently and pause on hidden tabs to honour
        // the polling-perf rule (never on the trade hot path).
        refetchInterval: 30_000,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
      },
    },
  );

  const read: MarketTimingRead | null = data ?? null;

  // Live freshness timer — ticks once a second while open + visible.
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNowTs(Date.now());
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id == null) id = setInterval(() => setNowTs(Date.now()), 1000);
    };
    const stop = () => {
      if (id != null) {
        clearInterval(id);
        id = null;
      }
    };
    const onVis = () => (document.hidden ? stop() : (setNowTs(Date.now()), start()));
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [open]);

  // Shared scanner-truth gate — when the ONE truth contract is not fully
  // actionable, this advisory card must suppress its GO/grade/scores/best-action
  // and render an honest downgrade panel instead, so it can never show a
  // confident timing read over stale / delayed / insufficient / blocked data.
  // The compact ScannerReadGate caption in the header is the headline notice
  // (and still shows when the card is collapsed); this is the in-body content gate.
  const gate = useScannerReadGate(symbol);

  // News is the ONE shared news state (Task #512): driven by the per-symbol
  // truth snapshot so this card can never disagree with the chart's Impact
  // Radar about an active high-impact window. The "no calendar provider"
  // disclaimer renders ONCE on the radar — never duplicated here.
  const [timeframe] = useScannerTimeframe();
  const { news } = useSymbolTruth(symbol, timeframe, {
    enabled: !!symbol && open,
  });
  const newsEvent =
    news?.events.find((e) => e.affectsSymbol) ?? news?.events[0] ?? null;
  const newsBlocks = news?.highImpactWindowActive === true;

  const isUnavailable = !!read && read.dataQuality.label === "unavailable";
  const quality = read ? QUALITY_NOTE[read.dataQuality.label] ?? QUALITY_NOTE["unavailable"]! : null;

  return (
    <div
      className="rounded-2xl border border-primary/25 bg-card p-4"
      data-testid="timing-intelligence"
    >
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
          <Gauge className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-foreground">Timing Intelligence</span>
            <span className="text-xs text-txt-muted">{symbol}</span>
          </div>
          <p className="text-[11px] text-txt-muted">Advisory only — never gates a trade.</p>
          <ScannerReadGate symbol={symbol} compact />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 px-2.5 text-xs"
            disabled={isFetching}
            onClick={() => void refetch()}
            data-testid="timing-intelligence-refresh"
          >
            {isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="grid h-8 w-8 place-items-center rounded-lg text-txt-muted hover:bg-background/60"
            aria-label={open ? "Collapse" : "Expand"}
            data-testid="timing-intelligence-toggle"
          >
            <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 space-y-3" data-testid="timing-intelligence-body">
          {isLoading ? (
            <div className="space-y-2" data-testid="timing-intelligence-skeleton">
              <div className="h-8 w-1/2 animate-pulse rounded-lg bg-background/60" />
              <div className="grid grid-cols-3 gap-2">
                <div className="h-12 animate-pulse rounded-lg bg-background/60" />
                <div className="h-12 animate-pulse rounded-lg bg-background/60" />
                <div className="h-12 animate-pulse rounded-lg bg-background/60" />
              </div>
            </div>
          ) : isError ? (
            <p className="text-sm text-danger" data-testid="timing-intelligence-err">
              {name} couldn't read the timing for {symbol} just now. Try again in a moment.
            </p>
          ) : !read ? (
            <p className="text-sm text-txt-secondary">No timing read available for {symbol} yet.</p>
          ) : isUnavailable ? (
            <div
              className="rounded-xl border border-warning/30 bg-warning/5 px-3 py-3"
              data-testid="timing-intelligence-unavailable"
            >
              <div className="flex items-center gap-2 text-sm font-medium text-warning">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Timing read unavailable
              </div>
              <p className="mt-1 text-xs text-txt-secondary">
                {read.dataQuality.note ||
                  "Not enough live data to produce a meaningful timing read right now."}
              </p>
            </div>
          ) : gate.downgraded ? (
            <div
              className="rounded-xl border border-warning/30 bg-warning/5 px-3 py-3"
              data-testid="timing-intelligence-downgraded"
            >
              <div className="flex items-center gap-2 text-sm font-medium text-warning">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Timing read not actionable
              </div>
              <p className="mt-1 text-xs text-txt-secondary">
                This is a{" "}
                {gate.level === "blocked"
                  ? "blocked"
                  : gate.level === "limited"
                    ? "delayed / limited"
                    : "historical"}{" "}
                read — the live feed for {symbol} isn't confirmed, so the timing
                grade, entry permission, and scores are held back to avoid showing
                a confident read over unstable data.
                {gate.reason ? ` ${gate.reason}` : ""}
              </p>
            </div>
          ) : (
            <>
              {/* Top row: grade + permission + freshness/quality */}
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-sm font-bold leading-none",
                    GRADE_COLORS[read.timingGrade] ?? "bg-muted/60 text-muted-foreground border-border",
                  )}
                  title={`Timing grade: ${read.timingGrade}`}
                  data-testid="timing-intelligence-grade"
                >
                  <Flame className="h-3.5 w-3.5" />
                  {read.timingGrade}
                </span>

                <span
                  className={cn(
                    "inline-flex items-center rounded-lg border px-2 py-1 text-xs font-semibold leading-none",
                    PERMISSION_COLORS[read.entryPermission] ??
                      "bg-muted/60 text-muted-foreground border-border",
                  )}
                  title={read.actionReason}
                  data-testid="timing-intelligence-permission"
                >
                  {humanize(PERMISSION_LABELS, read.entryPermission)}
                </span>

                {/* Pressure bias */}
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-semibold leading-none",
                    read.pressureBias === "BUY"
                      ? "border-success/40 bg-success/10 text-success"
                      : read.pressureBias === "SELL"
                        ? "border-danger/40 bg-danger/10 text-danger"
                        : "border-border bg-background/30 text-txt-muted",
                  )}
                >
                  {read.pressureBias === "BUY" ? (
                    <TrendingUp className="h-3 w-3" />
                  ) : read.pressureBias === "SELL" ? (
                    <TrendingDown className="h-3 w-3" />
                  ) : (
                    <Minus className="h-3 w-3" />
                  )}
                  {read.pressureBias}
                </span>

                {quality && (
                  <span
                    className={cn("ml-auto flex items-center gap-1 text-[11px]", quality.tone)}
                    data-testid="timing-intelligence-quality"
                  >
                    <Clock className="h-3 w-3" />
                    {quality.text} · {ageLabel(read.generatedAt, nowTs)}
                  </span>
                )}
              </div>

              {/* News overlay warning — only when it actually blocks a trade */}
              {newsBlocks && (
                <div
                  className="flex items-start gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-2 text-xs text-warning"
                  data-testid="timing-intelligence-news-warning"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {newsEvent
                      ? `${newsEvent.title} — hold off; news window active.`
                      : "High-impact news window active — hold off until it settles."}
                  </span>
                </div>
              )}

              {/* Score pills */}
              <div className="grid grid-cols-3 gap-2" data-testid="timing-intelligence-scores">
                <ScorePill label="Heat" value={read.heatScore} tone="good" icon={<Flame className="h-2.5 w-2.5" />} />
                <ScorePill label="Tradeability" value={read.tradeabilityScore} tone="good" icon={<Activity className="h-2.5 w-2.5" />} />
                <ScorePill label="Danger" value={read.dangerScore} tone="bad" icon={<AlertTriangle className="h-2.5 w-2.5" />} />
              </div>

              {/* Best action */}
              <div className="rounded-xl border border-border bg-background/40 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-txt-muted">
                  Best action
                </div>
                <p
                  className="mt-0.5 text-sm font-semibold text-foreground"
                  data-testid="timing-intelligence-best-action"
                >
                  {humanize(ACTION_LABELS, read.bestAction)}
                </p>
                {read.actionReason && (
                  <p className="mt-1 text-xs leading-snug text-txt-secondary italic">
                    {read.actionReason}
                  </p>
                )}
              </div>

              {/* Session + kill zone */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span
                  className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/40 px-2 py-1 text-txt-secondary"
                  data-testid="timing-intelligence-session"
                >
                  <Clock className="h-3 w-3 text-txt-muted" />
                  {read.session.sessionName}
                </span>
                {read.session.isKillZoneActive && (
                  <span
                    className="inline-flex items-center gap-1 rounded-lg border border-warning/25 bg-warning/10 px-2 py-1 font-semibold text-warning"
                    data-testid="timing-intelligence-killzone"
                  >
                    <Flame className="h-3 w-3" />
                    Kill zone active
                  </span>
                )}
              </div>

              {read.session.sessionDescription && (
                <p className="text-[11px] leading-snug text-txt-muted">
                  {read.session.sessionDescription}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default TimingIntelligenceCard;
