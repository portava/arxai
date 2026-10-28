import { useEffect, useMemo, useState } from "react";
import { Sparkles, Loader2, ChevronDown, RefreshCw, Clock, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScannerReadGate } from "@/components/scanner/ScannerReadGate";
import { useScannerReadGate } from "@/hooks/useScannerReadGate";
import { useScannerTimeframe } from "@/hooks/useScannerTimeframe";
import { useSymbolTruth } from "@/hooks/useSymbolTruth";
import { formatInstrumentPrice } from "@/lib/instrumentPriceFormat";
import { TruthEvidenceClasses } from "@/components/scanner/TruthEvidenceClasses";
import { useEvidenceDeadline } from "@/hooks/useEvidenceDeadline";
import { normalizeChartTimeframe, toApiTimeframe } from "@/lib/chartCandlesQuery";
import { RubyReasoningBlock } from "@/components/ruby/RubyReasoningBlock";
import { buildReasoningFromMarketRead } from "@/lib/rubyReasoningBlock";
import { useAssistantName } from "@/lib/assistant-name";
import { eventRiskLine } from "@/lib/eventRiskCopy";
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

// Levels print at the instrument's display precision — the same precision the
// header, chart badge and price axis use (lib/instrumentPriceFormat) — so a
// level never carries fewer digits than the quote it is compared against.
function fmtNum(n: number | null | undefined, precision: number | null | undefined): string {
  return formatInstrumentPrice(n, precision);
}

function fmtZone(z: SignalPriceZone | null | undefined, precision: number | null | undefined): string {
  if (!z) return "—";
  if (z.from === z.to) return fmtNum(z.from, precision);
  return `${fmtNum(z.from, precision)} – ${fmtNum(z.to, precision)}`;
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

// Live "updated Xs ago" timer from a DATA timestamp (newest observed of the
// snapshot's lastTickAt / closed lastCandleAt — never the signal build-time and
// never a forming bar's scheduled close) against a ticking now.
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
// The newest OBSERVED data time from the market-truth snapshot. A tick time is
// an observation (a small future skew is clamped by ageLabel). A candle time is
// a closeTime, which for the forming bar is a scheduled future boundary — it
// only counts once it is no longer in the future.
function resolveDataUpdated(
  lastTickAt: string | null | undefined,
  lastCandleAt: string | null | undefined,
  nowTs: number,
): { dataUpdatedIso: string | null; formingCloseOnly: boolean } {
  const tick = lastTickAt ? Date.parse(lastTickAt) : NaN;
  const candle = lastCandleAt ? Date.parse(lastCandleAt) : NaN;
  const stamps: number[] = [];
  if (Number.isFinite(tick)) stamps.push(tick);
  const candleIsScheduled = Number.isFinite(candle) && candle > nowTs;
  if (Number.isFinite(candle) && !candleIsScheduled) stamps.push(candle);
  if (stamps.length === 0) return { dataUpdatedIso: null, formingCloseOnly: candleIsScheduled };
  return { dataUpdatedIso: new Date(Math.max(...stamps)).toISOString(), formingCloseOnly: false };
}

// The Market Read header's feed row, as one ordered downgrade (client can only
// lower the server's word, never raise it):
//   1. the shared gate is downgraded / the read expired → "Feed not confirmed";
//   2. no data time from the market-truth snapshot → "Feed time unconfirmed";
//   3. the snapshot's data state isn't LIVE_CONFIRMED → "Live (unconfirmed)";
//   4. otherwise the signal's own word + "updated Xs ago".
// `feedDataNote` is the matching Feed/Data line for the reasoning block (null
// when the feed is confirmed or step 1 already explains it).
function resolveFeedRow(input: {
  signal: RubyMarketEdgeSignal | null;
  downgraded: boolean;
  dataUpdatedIso: string | null;
  /** True when the only data time is a forming bar's scheduled (future) close. */
  formingCloseOnly?: boolean;
  snapshotState: string | null;
  nowTs: number;
}): { text: string; tone: string; feedDataNote: string | null } {
  const { signal, downgraded, dataUpdatedIso, snapshotState, nowTs } = input;
  if (!signal) return { text: "", tone: "text-txt-muted", feedDataNote: null };
  const f = freshnessLabel(signal);
  if (downgraded) {
    const age = dataUpdatedIso ? ` · ${ageLabel(dataUpdatedIso, nowTs)}` : "";
    return { text: `Feed not confirmed${age}`, tone: "text-warning", feedDataNote: null };
  }
  if (dataUpdatedIso == null && input.formingCloseOnly) {
    return {
      text: "Feed time unconfirmed — only the forming bar's scheduled close was reported, no tick time",
      tone: "text-warning",
      feedDataNote:
        "Feed time unconfirmed — the market-truth snapshot reports only the forming bar's scheduled close and no tick time, so the live feed can't be confirmed here.",
    };
  }
  if (dataUpdatedIso == null) {
    return {
      text: "Feed time unconfirmed — market-truth snapshot unavailable",
      tone: "text-warning",
      feedDataNote:
        "Feed time unconfirmed — the market-truth snapshot is unavailable, so the live feed can't be confirmed here.",
    };
  }
  const age = ageLabel(dataUpdatedIso, nowTs);
  const state = String(snapshotState ?? "").toUpperCase();
  if (state !== "LIVE_CONFIRMED") {
    const word = f.text === "Live feed" ? "Live (unconfirmed)" : f.text;
    const stateWord = state ? state.toLowerCase() : "unknown";
    return {
      text: `${word} · ${age}`,
      tone: "text-warning",
      feedDataNote: `Live feed not confirmed — the market-truth snapshot reads ${stateWord}.`,
    };
  }
  const tone = FRESHNESS_TONE[String(signal.freshness ?? "").toUpperCase()] ?? f.tone;
  // Never paint a non-live word green just because the signal is young.
  return { text: `${f.text} · ${age}`, tone: f.text === "Live feed" ? tone : f.tone, feedDataNote: null };
}

// The per-symbol Truth Snapshot's news state, as the card states it.
type NewsCheck = "loading" | "unavailable" | "unchecked" | "no_calendar" | "ok";
function newsCheckState(
  news: { providerConnected?: boolean; riskUnchecked?: boolean } | null | undefined,
  loading: boolean,
): NewsCheck {
  if (news == null) return loading ? "loading" : "unavailable";
  if (news.riskUnchecked === true) return "unchecked";
  if (news.providerConnected === false) return "no_calendar";
  return "ok";
}
const NEWS_GAP_TEXT: Record<Exclude<NewsCheck, "ok">, string> = {
  loading: "a scheduled-news check (event-risk read still loading)",
  unavailable: "a scheduled-news check (event-risk read unavailable)",
  unchecked: "a scheduled-news check (the calendar could not be checked)",
  no_calendar: "a scheduled-news check (no event calendar connected)",
};

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
  const [scannerTimeframe] = useScannerTimeframe();
  // Missing props follow the scanner selection. An empty value previously
  // requested an unrelated M5 read while the card's gate used the chart bus.
  const chartTimeframe = normalizeChartTimeframe(timeframe || scannerTimeframe);
  const apiTimeframe = toApiTimeframe(chartTimeframe);
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
    () => ({ symbol, timeframe: apiTimeframe }),
    [symbol, apiTimeframe],
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
  const gate = useScannerReadGate(symbol, chartTimeframe);

  // Task #515 — news state and the "updated X ago" freshness anchor come from
  // the ONE per-symbol Truth Snapshot, so this card can never disagree with the
  // chart / scanner rows on the same page. The age is anchored to the DATA
  // timestamp (newest of lastTickAt / lastCandleAt), never the signal build time.
  const {
    news,
    newsState: hookNewsState,
    data: truthData,
    evidence: truthEvidence,
    scannerTruth,
    isLoading: truthLoading,
  } = useSymbolTruth(symbol, chartTimeframe);
  // ONE event-risk sentence for the News block AND the Risk row (eventRiskCopy).
  // A hook without `newsState` (older callers) falls back to its own loading
  // flag, so a first fetch in flight still reads "Checking", never "unavailable".
  const newsState =
    hookNewsState ?? (news != null ? "available" : truthLoading ? "loading" : "unavailable");
  const eventRisk = eventRiskLine(news, newsState);
  const pricePrecision = scannerTruth?.candles.pricePrecision ?? null;
  // lastCandleAt is a candle's closeTime: for the still-forming bar it is the
  // SCHEDULED future close, not an observation, so it never anchors the age
  // (it would otherwise win the max and read "updated 0s ago" all bar long).
  const { dataUpdatedIso, formingCloseOnly } = useMemo(
    () => resolveDataUpdated(truthData?.lastTickAt, truthData?.lastCandleAt, nowTs),
    [truthData?.lastTickAt, truthData?.lastCandleAt, nowTs],
  );

  const explanation: RubyMarketReadExplanation | null = data?.explanation ?? null;
  const signal = data?.signal ?? null;

  // ONE news-check state for the needs list and the Risk row, so the card can
  // never say "unavailable" in one place and "loading" in another. A 24/7
  // synthetic index is price-driven (the heat list says so on the same page):
  // a scheduled-news check is not something the read still NEEDS — the Risk
  // row still states plainly that event risk wasn't assessed.
  const isSynthetic = String(signal?.assetClass ?? "").toLowerCase() === "synthetic";
  const newsCheck = newsCheckState(news, !!truthLoading);
  const newsGap = isSynthetic || newsCheck === "ok" ? null : NEWS_GAP_TEXT[newsCheck];
  const displayNeeds = explanation
    ? [...explanation.missingContext, ...(newsGap ? [newsGap] : [])]
    : [];

  // The read is fetched once (no polling). A live chart cannot keep an expired
  // read current: past/missing/malformed expiresAt, or an expired/invalid
  // lifecycle, withholds the directional content exactly like a downgraded feed.
  const expiresAtMs = typeof signal?.expiresAt === "string" ? Date.parse(signal.expiresAt) : NaN;
  const readNowMs = useEvidenceDeadline(Number.isFinite(expiresAtMs) ? expiresAtMs : null);
  const readExpired = signal != null && (!(Number.isFinite(expiresAtMs) && readNowMs < expiresAtMs) ||
    ["EXPIRED", "STALE"].includes(String(signal.freshness ?? "").toUpperCase()) ||
    ["EXPIRED", "INVALID"].includes(String(signal.lifecycleStage ?? "").toUpperCase()));
  const downgraded = gate.downgraded || readExpired;
  // The header's feed word is the SIGNAL's build-time dataSource (fetched once,
  // never polled); it may only be shown as live when the market-truth snapshot
  // on this page confirms a current data time. Ordered, downgrade-only.
  const feedRow = resolveFeedRow({
    signal,
    downgraded,
    dataUpdatedIso,
    formingCloseOnly,
    snapshotState: truthData?.state ?? null,
    nowTs,
  });
  const level = gate.level;
  const reason = readExpired && !gate.downgraded
    ? `This ${name} read has expired — refresh for a current read.`
    : gate.reason;

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
            newsRiskLabel: eventRisk,
            feedUnconfirmedReason: feedRow.feedDataNote,
          }, name)
        : null,
    [explanation, signal, downgraded, level, reason, eventRisk, feedRow.feedDataNote, name],
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
            <span className="text-xs text-txt-muted">{symbol} · {chartTimeframe}</span>
          </div>
          <ScannerReadGate symbol={symbol} timeframe={chartTimeframe} compact />
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
          ) : level == null ? (
            <p className="text-sm text-txt-secondary" data-testid="ruby-market-read-confirming">
              {reason ?? "Confirming market data before showing a directional read."}
            </p>
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
                  <span
                    className={`ml-auto flex items-center gap-1 text-xs ${feedRow.tone}`}
                    data-testid="ruby-market-read-freshness"
                  >
                    <Clock className="h-3 w-3" /> {feedRow.text}
                  </span>
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
                <MetaChip label="Signal stage" value={downgraded ? "—" : humanize(STAGE_LABEL, signal.lifecycleStage)} testid="ruby-market-read-stage" />
                <MetaChip label="Bias" value={downgraded ? "—" : humanize(BIAS_LABEL, signal.bias)} testid="ruby-market-read-bias" />
                <MetaChip
                  label="Trade quality"
                  value={downgraded ? "—" : qualityValue(signal)}
                  hint={downgraded ? undefined : qualityHint(signal)}
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
                  {eventRisk}
                </p>
              </div>

              {/* Best action — suppressed to an honest "not actionable" line when
                  the shared scanner truth is downgraded (never present a
                  confident action over stale/insufficient/blocked data). */}
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-txt-muted">Best action</div>
                {readExpired && !gate.downgraded ? (
                  <p className="mt-0.5 text-sm text-txt-muted" data-testid="ruby-market-read-best-action-expired">
                    Not actionable — {reason}
                  </p>
                ) : downgraded ? (
                  <p className="mt-0.5 text-sm text-txt-muted" data-testid="ruby-market-read-best-action-downgraded">
                    Not actionable on the current feed — this is a{" "}
                    {level === "blocked"
                      ? "blocked"
                      : level === "limited"
                        ? "delayed / limited"
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
                    <LevelCell label="Entry zone" value={fmtZone(explanation.levels.entryZone, pricePrecision)} />
                    <LevelCell label="Watch zone" value={fmtZone(explanation.levels.watchZone, pricePrecision)} />
                    <LevelCell label="Don't-chase zone" value={fmtZone(explanation.levels.lateZone, pricePrecision)} />
                    <LevelCell label="Stop loss" value={fmtNum(explanation.levels.stopLoss, pricePrecision)} />
                    <LevelCell label="Invalidation" value={fmtNum(explanation.levels.invalidation, pricePrecision)} />
                    <LevelCell
                      label="Take profits"
                      value={explanation.levels.takeProfits.length ? explanation.levels.takeProfits.map((z) => fmtZone(z, pricePrecision)).join(", ") : "—"}
                    />
                  </div>
                </Collapsible>
              )}

              {/* No-trade intelligence */}
              {explanation.noTrade.isNoTrade && (
                <div className="rounded-xl border border-border bg-background/40 p-3" data-testid="ruby-market-read-no-trade">
                  {/* noTrade.confidence is a fixed weight per no-trade rule
                      (basis RULE_TIER), not a measured probability, so it is
                      never rendered as "% sure" — the rule's reason is the claim. */}
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">Why sitting out is the trade</span>
                  </div>
                  {explanation.noTrade.reason && (
                    <p className="mt-1 text-sm leading-snug text-txt-secondary">{explanation.noTrade.reason}</p>
                  )}
                </div>
              )}

              {/* Missing context (honest gating) */}
              {displayNeeds.length > 0 && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2" data-testid="ruby-market-read-missing">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-warning">Before acting, {name} still needs</div>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-txt-secondary">
                    {displayNeeds.map((m, i) => <li key={i}>{m}</li>)}
                  </ul>
                </div>
              )}

              <p className="text-[10px] italic text-txt-muted">{explanation.disclaimer}</p>
            </>
          )}
          {/* Per-claim evidence classes from the ONE Truth Snapshot (already
              capped client-side; can only be downgraded). Shown in every body
              state so "unavailable" is stated rather than hidden. */}
          <TruthEvidenceClasses evidence={truthEvidence} testid="ruby-market-read-evidence-classes" />
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

function MetaChip({ label, value, hint, testid }: { label: string; value: string; hint?: string; testid?: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-2" data-testid={testid}>
      <div className="text-[10px] uppercase tracking-wide text-txt-muted">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-foreground">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] leading-snug text-txt-muted">{hint}</div>}
    </div>
  );
}

// Trade quality: the band word ("Modest") is a grade, so it is shown only when
// the server says every score input was observed (confidenceBandBasis FULL).
// On a PARTIAL basis — or an older server that does not say — the card shows
// the number and how many inputs were fixed defaults, never the grade. The
// client never re-derives a band; it can only withhold the server's.
const SCORE_INPUT_COUNT = 7;
const SCORE_INPUT_PLAIN: Record<string, string> = {
  direction: "direction",
  entry: "entry",
  execution: "execution",
  risk: "reward-to-risk",
  newsSafety: "news",
  timing: "timing",
  survivability: "room to target",
};
type QualitySignal = {
  confidenceBand: string;
  confidenceBandBasis?: string;
  scores?: { overall: number; unmeasured?: string[] } | null;
};
function qualityValue(signal: QualitySignal): string {
  const score = signal.scores ? `${Math.round(signal.scores.overall)}/100` : null;
  if (signal.confidenceBandBasis === "FULL") {
    return `${humanize(BAND_LABEL, signal.confidenceBand)}${score ? ` · ${score}` : ""}`;
  }
  if (!score) return "—";
  const n = signal.scores?.unmeasured?.length ?? 0;
  return n > 0 ? `${score} · ${n} of ${SCORE_INPUT_COUNT} inputs unmeasured` : `${score} · not graded`;
}
function qualityHint(signal: QualitySignal): string | undefined {
  if (signal.confidenceBandBasis === "FULL") return undefined;
  const missing = signal.scores?.unmeasured ?? [];
  if (missing.length === 0) return "Not graded — the score basis was not reported.";
  return `Not graded — no reading for ${missing.map((k) => SCORE_INPUT_PLAIN[k] ?? k).join(", ")}.`;
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
