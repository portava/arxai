import { useEffect, useMemo, useState } from "react";
import { Sparkles, Loader2, ChevronDown, RefreshCw, Clock, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScannerReadGate } from "@/components/scanner/ScannerReadGate";
import { useScannerReadGate } from "@/hooks/useScannerReadGate";
import { useSymbolTruth } from "@/hooks/useSymbolTruth";
import { RubyReasoningBlock } from "@/components/ruby/RubyReasoningBlock";
import { buildReasoningFromMarketRead } from "@/lib/rubyReasoningBlock";
import { useAssistantName } from "@/lib/assistant-name";
import { useGetMeMarketEdge, getGetMeMarketEdgeQueryKey } from "@workspace/api-client-react";
import type {
  RubyMarketReadExplanation,
  RubyExplanationMode,
  RubyMarketEdgeSignal,
  SignalPriceZone,
} from "@workspace/api-client-react";

// RubyMarketReadCard — surfaces the Phase 1 Ruby Market Edge signal as a rich,
// plain-English "Ruby Market Read" (Task #195).
//
// SAFETY: reads ONLY the read-only `GET /api/me/market-edge` intelligence
// endpoint. It NEVER places, modifies, or closes a trade. When the signal is
// blind / insufficient the explanation collapses to an honest watching state
// with no invented levels (the backend explanation engine enforces this); this
// component renders exactly what it is given and never fabricates prices.

const MODE_KEY = "scanner.rubyMarketRead.mode";

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 4 : 5;
  return n.toFixed(digits);
}

function fmtZone(z: SignalPriceZone | null | undefined): string {
  if (!z) return "—";
  if (z.from === z.to) return fmtNum(z.from);
  return `${fmtNum(z.from)} – ${fmtNum(z.to)}`;
}

function freshnessLabel(signal: RubyMarketEdgeSignal): { text: string; tone: string } {
  const ds = String(signal.dataSource ?? "").toUpperCase();
  if (ds === "LIVE_FEED") return { text: "Live feed", tone: "text-success" };
  if (ds === "LIVE_DELAYED") return { text: "Live (delayed)", tone: "text-warning" };
  if (ds === "AWAITING_FEED") return { text: "Awaiting live feed", tone: "text-warning" };
  if (ds.includes("HISTORY")) return { text: "History only", tone: "text-warning" };
  return { text: "No live feed", tone: "text-txt-muted" };
}

// Plain-English labels for the signal enums — never leak the raw token to users.
const STAGE_LABEL: Record<string, string> = {
  WATCHING: "Watching",
  TREND_FORMING: "Trend forming",
  SETUP_FORMING: "Setup forming",
  ENTRY_APPROACHING: "Entry approaching",
  ENTRY_WINDOW_OPEN: "Entry window open",
  LATE: "Late",
  INVALID: "Invalid",
  EXPIRED: "Expired",
};
const BIAS_LABEL: Record<string, string> = {
  BULLISH: "Bullish",
  BEARISH: "Bearish",
  RANGING: "Ranging",
  MIXED: "Mixed",
  UNCLEAR: "Unclear",
};
const BAND_LABEL: Record<string, string> = {
  NONE: "No edge",
  LOW: "Low",
  MODEST: "Modest",
  FAIR: "Fair",
  STRONG: "Strong",
  VERY_STRONG: "Very strong",
};
function humanize(map: Record<string, string>, raw: string | null | undefined): string {
  if (!raw) return "—";
  return map[String(raw).toUpperCase()] ?? "—";
}

// Live "updated Xs ago" timer from a DATA timestamp (newest of the snapshot's
// lastTickAt / lastCandleAt — never the signal build-time) against a ticking now.
function ageLabel(dataIso: string | null | undefined, nowTs: number): string {
  if (!dataIso) return "—";
  const t = Date.parse(dataIso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((nowTs - t) / 1000));
  if (s < 60) return `updated ${s}s ago`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `updated ${m}m ${rem}s ago`;
}
const FRESHNESS_TONE: Record<string, string> = {
  FRESH: "text-success",
  ACTIVE: "text-success",
  AGING: "text-warning",
  STALE: "text-warning",
  EXPIRED: "text-danger",
};

export function RubyMarketReadCard({
  symbol,
  timeframe,
}: {
  symbol: string;
  timeframe?: string;
}) {
  const { name } = useAssistantName();
  const [mode, setMode] = useState<"SIMPLE" | "ADVANCED">(() => {
    if (typeof window === "undefined") return "SIMPLE";
    const saved = window.localStorage.getItem(MODE_KEY);
    return saved === "ADVANCED" ? "ADVANCED" : "SIMPLE";
  });

  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  // Live freshness timer — ticks once a second while the tab is visible (pauses
  // on hidden tabs to honour the polling-perf rule). The card body (including the
  // always-visible Ruby Reasoning Block) is never collapsed, so the timer runs
  // for the card's whole lifetime.
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
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
  }, []);

  const params = useMemo(
    () => ({ symbol, ...(timeframe ? { timeframe } : {}) }),
    [symbol, timeframe],
  );

  const { data, isLoading, isFetching, isError, refetch } = useGetMeMarketEdge(params, {
    query: {
      queryKey: getGetMeMarketEdgeQueryKey(params),
      enabled: !!symbol,
      refetchOnWindowFocus: false,
    },
  });

  // Shared scanner-truth gate — when the ONE truth contract is not fully
  // actionable (stale / delayed / insufficient / blocked), this card must
  // downgrade its CONTENT (suppress actionable best-action + levels, drop the
  // /100 confidence numbers) so it can never look more confident than the rest
  // of the scanner. The compact ScannerReadGate caption above is the headline
  // notice; this is the in-body content gate.
  const { downgraded, level, reason } = useScannerReadGate(symbol);

  // Task #515 — news state and the "updated X ago" freshness anchor come from
  // the ONE per-symbol Truth Snapshot, so this card can never disagree with the
  // chart / scanner rows on the same page. The age is anchored to the DATA
  // timestamp (newest of lastTickAt / lastCandleAt), never the signal build time.
  const { news, data: truthData } = useSymbolTruth(symbol, timeframe ?? "");
  const dataUpdatedIso = useMemo(() => {
    const stamps = [truthData?.lastTickAt, truthData?.lastCandleAt]
      .map((s) => (s ? Date.parse(s) : NaN))
      .filter((n) => Number.isFinite(n)) as number[];
    return stamps.length > 0 ? new Date(Math.max(...stamps)).toISOString() : null;
  }, [truthData?.lastTickAt, truthData?.lastCandleAt]);

  const explanation: RubyMarketReadExplanation | null = data?.explanation ?? null;
  const signal = data?.signal ?? null;

  const chosen: RubyExplanationMode | null = explanation
    ? mode === "ADVANCED"
      ? explanation.advanced
      : explanation.simple
    : null;

  // Standardized, always-visible Ruby Reasoning Block. Built honesty-aware: the
  // shared scanner-truth downgrade verdict and the per-symbol news label are
  // passed in so a stale/delayed/insufficient/blocked feed yields a WAIT /
  // conditional read with the limitation stated in Feed/Data — never a fabricated
  // direction or level.
  const reasoning = useMemo(
    () =>
      explanation && signal
        ? buildReasoningFromMarketRead({
            explanation,
            signal,
            downgraded,
            level,
            reason,
            newsRiskLabel: news?.riskLabel ?? null,
          }, name)
        : null,
    [explanation, signal, downgraded, level, reason, news?.riskLabel, name],
  );

  return (
    <div
      className="rounded-2xl border border-ruby/25 bg-card p-4"
      data-testid="ruby-market-read"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-ruby/15 text-ruby ring-1 ring-ruby/25">
          <Sparkles className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[15px] font-semibold text-foreground">{name} Market Read</span>
            <span className="text-xs text-txt-muted">{symbol}{timeframe ? ` · ${timeframe}` : ""}</span>
          </div>
          <ScannerReadGate symbol={symbol} compact />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {/* Simple / Advanced toggle */}
          <div className="flex rounded-lg border border-border p-0.5" role="group" aria-label="Explanation detail">
            <button
              type="button"
              onClick={() => setMode("SIMPLE")}
              className={`rounded-md px-2 py-1 text-xs font-medium ${mode === "SIMPLE" ? "bg-primary text-white" : "text-txt-secondary"}`}
              data-testid="ruby-market-read-mode-simple"
            >
              Simple
            </button>
            <button
              type="button"
              onClick={() => setMode("ADVANCED")}
              className={`rounded-md px-2 py-1 text-xs font-medium ${mode === "ADVANCED" ? "bg-primary text-white" : "text-txt-secondary"}`}
              data-testid="ruby-market-read-mode-advanced"
            >
              Advanced
            </button>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 px-2.5 text-xs"
            disabled={isFetching}
            onClick={() => void refetch()}
            data-testid="ruby-market-read-refresh"
          >
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      {(
        <div className="mt-3 space-y-3" data-testid="ruby-market-read-body">
          {isLoading ? (
            <p className="text-sm text-txt-secondary">{name} is reading {symbol}…</p>
          ) : isError ? (
            <p className="text-sm text-danger" data-testid="ruby-market-read-err">
              {name} couldn't read this market just now. Try again in a moment.
            </p>
          ) : !explanation || !chosen || !signal ? (
            <p className="text-sm text-txt-secondary">No read available for {symbol} yet.</p>
          ) : (
            <>
              {/* Standardized, always-visible Ruby Reasoning Block — never behind
                  a collapse/accordion. Full labeled thesis the trader sees first. */}
              {reasoning && (
                <RubyReasoningBlock data={reasoning} testid="ruby-market-read-reasoning" />
              )}

              {/* Headline + freshness + late warning */}
              <div className="rounded-xl border border-border bg-background/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground" data-testid="ruby-market-read-headline">
                    {explanation.headline}
                  </span>
                  {(() => {
                    const f = freshnessLabel(signal);
                    const tone = FRESHNESS_TONE[String(signal.freshness ?? "").toUpperCase()] ?? f.tone;
                    return (
                      <span
                        className={`ml-auto flex items-center gap-1 text-xs ${tone}`}
                        data-testid="ruby-market-read-freshness"
                      >
                        <Clock className="h-3 w-3" /> {f.text} · {ageLabel(dataUpdatedIso, nowTs)}
                      </span>
                    );
                  })()}
                </div>
                {signal.late?.isLate && (
                  <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs text-warning" data-testid="ruby-market-read-late">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{signal.late.reason ?? "This move may be late — chasing it carries extra risk."}</span>
                  </div>
                )}
              </div>

              {/* Signal metadata — stage / bias / trade quality / edge */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="ruby-market-read-meta">
                <MetaChip label="Stage" value={downgraded ? "—" : humanize(STAGE_LABEL, signal.lifecycleStage)} testid="ruby-market-read-stage" />
                <MetaChip label="Bias" value={downgraded ? "—" : humanize(BIAS_LABEL, signal.bias)} testid="ruby-market-read-bias" />
                <MetaChip
                  label="Trade quality"
                  value={
                    downgraded
                      ? "—"
                      : `${humanize(BAND_LABEL, signal.confidenceBand)}${signal.scores ? ` · ${Math.round(signal.scores.overall)}/100` : ""}`
                  }
                  testid="ruby-market-read-quality"
                />
                <MetaChip
                  label="Edge score"
                  value={downgraded ? "—" : `${Math.round(signal.edgeScore)}/100`}
                  testid="ruby-market-read-edge"
                />
              </div>

              {/* Evidence breakdown */}
              {signal.evidence && (
                <div className="rounded-xl border border-border bg-background/40 p-3" data-testid="ruby-market-read-evidence">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-txt-muted">Evidence</div>
                  <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="text-xs font-medium text-success">For this read</div>
                      {signal.evidence.for.length ? (
                        <ul className="mt-0.5 space-y-0.5 text-xs text-txt-secondary">
                          {signal.evidence.for.map((e, i) => <li key={i}>+ {e.label}</li>)}
                        </ul>
                      ) : (
                        <p className="mt-0.5 text-xs text-txt-muted">Nothing notable yet.</p>
                      )}
                    </div>
                    <div>
                      <div className="text-xs font-medium text-danger">Against</div>
                      {signal.evidence.against.length ? (
                        <ul className="mt-0.5 space-y-0.5 text-xs text-txt-secondary">
                          {signal.evidence.against.map((e, i) => <li key={i}>− {e.label}</li>)}
                        </ul>
                      ) : (
                        <p className="mt-0.5 text-xs text-txt-muted">Nothing notable yet.</p>
                      )}
                    </div>
                  </div>
                  {signal.evidence.conflicts.length > 0 && (
                    <div className="mt-2 text-xs text-warning">
                      Conflicts: {signal.evidence.conflicts.join("; ")}
                    </div>
                  )}
                </div>
              )}

              {/* News & economic impact — the SAME event-risk read the chart's
                  Impact Radar shows, from the ONE per-symbol Truth Snapshot. No
                  "no calendar provider" disclaimer here: it renders exactly once
                  on the page, in the chart's Impact Radar strip. */}
              <div className="rounded-xl border border-border bg-background/40 p-3" data-testid="ruby-market-read-news">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-txt-muted">News &amp; economic impact</div>
                <p className="mt-0.5 text-sm text-txt-secondary">
                  {news ? news.riskLabel : "Event risk is loading…"}
                </p>
              </div>

              {/* Best action — suppressed to an honest "not actionable" line when
                  the shared scanner truth is downgraded (never present a
                  confident action over stale/insufficient/blocked data). */}
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-txt-muted">Best action</div>
                {downgraded ? (
                  <p className="mt-0.5 text-sm text-txt-muted" data-testid="ruby-market-read-best-action-downgraded">
                    Not actionable on the current feed — this is a{" "}
                    {level === "blocked"
                      ? "blocked"
                      : level === "limited"
                        ? "delayed / limited"
                        : level == null
                          ? "unconfirmed"
                          : "historical"}{" "}
                    read.{reason ? ` ${reason}` : ""}
                  </p>
                ) : (
                  <p className="mt-0.5 text-sm font-medium text-foreground" data-testid="ruby-market-read-best-action">
                    {explanation.bestAction}
                  </p>
                )}
              </div>

              {/* Reason chain */}
              <div className="space-y-2">
                <ReasonRow label="What's happening" value={chosen.whatIsHappening} testid="ruby-market-read-what" />
                <ReasonRow label="Why" value={chosen.why} />
                <ReasonRow label="Why this market" value={chosen.whyThisMarket} />
                {/* READABILITY CONTRACT (display-only): the directional rationale is
                    withheld when the shared scanner truth is downgraded
                    (insufficient / stale / delayed / blocked) — no "why this
                    direction" without a confirmed directional read. */}
                {!downgraded && (
                  <ReasonRow label="Why this direction" value={chosen.whyThisDirection} />
                )}
                <ReasonRow label="Why now" value={chosen.whyNow} />
                <ReasonRow label="Timing" value={chosen.timingState} />
                {/* READABILITY CONTRACT (display-only): the actionable trade idea
                    (entry / risk / what confirms / what invalidates / what to do
                    next) is withheld when the shared scanner truth is downgraded
                    (insufficient / stale / delayed / blocked) — no trade idea or
                    recommendation without a confirmed directional read. The
                    read-only context rows above (what's happening / why / why this
                    market / why now / timing) stay. */}
                {!downgraded && (
                  <>
                    <ReasonRow label="Entry" value={chosen.entryZone} />
                    <ReasonRow label="Risk" value={chosen.risk} />
                    <ReasonRow label="What confirms it" value={chosen.whatConfirms} />
                    <ReasonRow label="What invalidates it" value={chosen.whatInvalidates} />
                    <ReasonRow label="What to do next" value={chosen.whatToDoNext} />
                  </>
                )}
              </div>

              {/* Levels — Ruby speaks in levels. Suppressed when the shared
                  scanner truth is downgraded (no actionable levels over an
                  unstable feed). */}
              {explanation.actionable && !downgraded && (
                <Collapsible label="Levels">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <LevelCell label="Entry zone" value={fmtZone(explanation.levels.entryZone)} />
                    <LevelCell label="Watch zone" value={fmtZone(explanation.levels.watchZone)} />
                    <LevelCell label="Don't-chase zone" value={fmtZone(explanation.levels.lateZone)} />
                    <LevelCell label="Stop loss" value={fmtNum(explanation.levels.stopLoss)} />
                    <LevelCell label="Invalidation" value={fmtNum(explanation.levels.invalidation)} />
                    <LevelCell
                      label="Take profits"
                      value={explanation.levels.takeProfits.length ? explanation.levels.takeProfits.map(fmtZone).join(", ") : "—"}
                    />
                  </div>
                </Collapsible>
              )}

              {/* No-trade intelligence */}
              {explanation.noTrade.isNoTrade && (
                <div className="rounded-xl border border-border bg-background/40 p-3" data-testid="ruby-market-read-no-trade">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">Why sitting out is the trade</span>
                    <span className="ml-auto text-xs text-txt-muted">{Math.round(explanation.noTrade.confidence)}% sure</span>
                  </div>
                  {explanation.noTrade.reason && (
                    <p className="mt-1 text-sm leading-snug text-txt-secondary">{explanation.noTrade.reason}</p>
                  )}
                </div>
              )}

              {/* Missing context (honest gating) */}
              {explanation.missingContext.length > 0 && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2" data-testid="ruby-market-read-missing">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-warning">Before acting, {name} still needs</div>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-txt-secondary">
                    {explanation.missingContext.map((m, i) => <li key={i}>{m}</li>)}
                  </ul>
                </div>
              )}

              <p className="text-[10px] italic text-txt-muted">{explanation.disclaimer}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ReasonRow({ label, value, testid }: { label: string; value: string; testid?: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 sm:grid-cols-[140px_1fr]">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-txt-muted">{label}</div>
      <p className="text-sm leading-snug text-txt-secondary" data-testid={testid}>{value}</p>
    </div>
  );
}

function MetaChip({ label, value, testid }: { label: string; value: string; testid?: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-2" data-testid={testid}>
      <div className="text-[10px] uppercase tracking-wide text-txt-muted">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function LevelCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-2">
      <div className="text-[10px] uppercase tracking-wide text-txt-muted">{label}</div>
      <div className="font-mono text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function Collapsible({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <span className="font-medium">{label}</span>
        <ChevronDown className={`ml-auto h-4 w-4 text-txt-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

export default RubyMarketReadCard;
