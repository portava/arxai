import { useEffect, useMemo } from "react";
import { Radar, Loader2, RefreshCw, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useGetMeOpportunityMap, getGetMeOpportunityMapQueryKey } from "@workspace/api-client-react";
import type {
  OpportunityMapRow,
  OpportunityMapRowCategory,
  OpportunityBestPicks,
  OpportunitySkippedSymbolReason,
} from "@workspace/api-client-react";
import {
  resolveScannerActionability,
  resolveSelectedSymbolActionability,
  SCANNER_ACTIONABILITY_UI,
  type ScannerActionability,
  type ActionabilityTone,
  type SetupReadiness,
} from "@/lib/scannerActionability";
import { useScannerTimeframe } from "@/hooks/useScannerTimeframe";
import { useAssistantName } from "@/lib/assistant-name";
import { useSymbolTruth } from "@/hooks/useSymbolTruth";
import { useSelectedActionStore } from "./selectedActionStore";
import { coerceVisibleTimeframe } from "./scannerChartFormat";
import { resolveSymbol } from "@/lib/symbolRegistry";
import { bareSymbol } from "@/lib/use-chart-symbol";
import { normalizeChartTimeframe, toApiTimeframe } from "@/lib/chartCandlesQuery";

// BroadScanOpportunityMap — categorized broad-scan opportunity map (Task #195).
//
// SAFETY: reads ONLY the read-only `GET /api/me/opportunity-map` endpoint, which
// is built from REAL scanner reads (simulator rows dropped). It NEVER places,
// modifies, or closes a trade. When there is no live data the backend returns an
// honest dataNote and empty buckets — this component renders that state and never
// fabricates opportunities.

type UniverseId = "all" | "forex" | "metals" | "crypto" | "stocks" | "synthetic";

const CATEGORY_META: Record<
  OpportunityMapRowCategory,
  { label: string; blurb: string; dot: string }
> = {
  READY_NOW: { label: "Ready now", blurb: "Clean setups with live data — act-ready.", dot: "bg-success" },
  FORMING_SOON: { label: "Forming soon", blurb: "Building — wait for the trigger.", dot: "bg-primary" },
  WATCH_AFTER_NEWS: { label: "Watch after news", blurb: "Event risk nearby — let it settle.", dot: "bg-warning" },
  TOO_LATE: { label: "Too late to chase", blurb: "Move already extended.", dot: "bg-txt-muted" },
  AVOID: { label: "Avoid", blurb: "Conditions are working against this.", dot: "bg-danger" },
  NO_CLEAN_SETUP: { label: "No clean setup", blurb: "Nothing tradeable right now.", dot: "bg-txt-muted" },
};

// When EVERY row in a group lacks live data, the group's OWN header must not
// inherit an affirmative readiness claim from the backend bucket — e.g. a
// READY_NOW section labelled "Ready now · Clean setups with live data —
// act-ready" sitting over rows that each individually degraded to the honest
// "Feed limited" verdict. The header is display-only: like the row cap, it can
// ONLY downgrade to honest context-only wording when the whole group is
// degraded; it never grants readiness and never touches a gate. A group with at
// least one live row keeps its real category header (the degraded rows inside
// still degrade individually).
const DEGRADED_GROUP_META: { label: string; blurb: string; dot: string } = {
  label: "Feed limited",
  blurb: "Needs live confirmation — context only, not a live entry.",
  dot: "bg-warning",
};

const CATEGORY_ORDER: OpportunityMapRowCategory[] = [
  "READY_NOW",
  "FORMING_SOON",
  "WATCH_AFTER_NEWS",
  "TOO_LATE",
  "AVOID",
  "NO_CLEAN_SETUP",
];

// Map the broad-scan's richer 6-category taxonomy onto the shared setup-readiness
// the ONE scanner action verdict consumes (Task #600). The visible section labels
// keep the finer taxonomy (AVOID stays distinct from NO_CLEAN_SETUP); this mapping
// only feeds the unified verdict so each row also carries the shared actionability
// vocabulary (exposed as `data-actionability`) — the same verdict the header strip,
// scalp cards, and trade ticket use, so a row can never disagree with them.
const CATEGORY_TO_SETUP: Record<OpportunityMapRowCategory, SetupReadiness> = {
  READY_NOW: "READY",
  FORMING_SOON: "WAIT",
  WATCH_AFTER_NEWS: "WAIT",
  TOO_LATE: "TOO_LATE",
  AVOID: "NO_CLEAN_SETUP",
  NO_CLEAN_SETUP: "NO_CLEAN_SETUP",
};

// Human copy for why a universe symbol was dropped from the scan (Task #600).
// Surfacing the reason makes "N of M scanned" reconcile with the universe — no
// symbol vanishes silently; the user can see exactly why each one was skipped.
const SKIPPED_REASON_COPY: Record<OpportunitySkippedSymbolReason, string> = {
  MISSING_FEED: "No live feed",
  LIMITED_HISTORY: "Limited history",
  STALE_DATA: "Stale data",
  UNSUPPORTED_SYMBOL: "Not supported",
  PROVIDER_ERROR: "Data error",
  EXCLUDED_BY_FILTER: "Filtered out",
};

// The unified per-row action verdict. A row WITHOUT live data is capped to a
// feed-limited verdict regardless of its category — the same data cap the scalp
// cards and header apply — so the broad scan can never present an act-ready verdict
// on a market it has no live feed for.
function rowActionability(row: OpportunityMapRow): ScannerActionability {
  const live = row.hasLiveData;
  return resolveScannerActionability(
    {
      quoteStatus: live ? "LIVE" : "UNAVAILABLE",
      candleStatus: live ? "CONFIRMED" : "UNAVAILABLE",
      chartIntelligenceStatus: live ? "FULL" : "UNAVAILABLE",
    },
    live ? CATEGORY_TO_SETUP[row.category] : "UNKNOWN",
  );
}

// The feed-degraded verdicts: the data itself can't support a live entry, so a
// row carrying one of these must NEVER show a direction/scores or read as
// act-ready. These are exactly the verdicts the chart header & Ruby Chart Read
// surface when the selected symbol's feed isn't live-confirmed.
const FEED_DEGRADED_VERDICTS: ReadonlySet<ScannerActionability> = new Set([
  "FEED_LIMITED",
  "ANALYSIS_ONLY",
  "MARKET_CLOSED",
]);

// Conservatism ordering for the SELECTED-symbol reconciliation. Higher = more
// restrictive (less act-ready). Used to guarantee the cross-surface cap can only
// ever DOWNGRADE the broad-scan row, never upgrade it: the selected feed verdict
// replaces the row's own verdict only when it is at least as severe.
const ACTIONABILITY_SEVERITY: Record<ScannerActionability, number> = {
  READY_NOW: 0,
  WAIT_FOR_CONFIRMATION: 1,
  TOO_LATE: 2,
  NO_CLEAN_SETUP: 2,
  ANALYSIS_ONLY: 3,
  FEED_LIMITED: 4,
  MARKET_CLOSED: 5,
};

// Canonical routing key for a symbol, so a broad-scan row matches the selected
// symbol across aliases (V75 / "VOLATILITY 75 INDEX" / "Volatility 75 Index" all
// resolve to the same canonical). Falls back to the upper-cased bare token when
// the registry can't resolve it (still a stable, alias-insensitive comparison).
function symbolKey(s: string | null | undefined): string | null {
  const raw = bareSymbol((s ?? "").trim());
  if (!raw) return null;
  return resolveSymbol(raw)?.canonicalSymbol.toUpperCase() ?? raw.toUpperCase();
}

// True when the broad-scan's scan timeframe matches the selected chart timeframe.
// The scan timeframe arrives in API form ("M5"); the chart timeframe is the bus
// display form ("15m") — normalize both to API form before comparing.
function sameTimeframe(scanApiTf: string | null, chartTf: string | null): boolean {
  if (!scanApiTf || !chartTf) return true;
  return (
    scanApiTf.toUpperCase() ===
    toApiTimeframe(normalizeChartTimeframe(chartTf)).toUpperCase()
  );
}

// Map the shared actionability tone onto a text colour for the verdict badge.
// Mirrors the file's existing convention (outline badge + tone className) so the
// ONE verdict drives the badge colour without inventing new Badge variants.
const ACTIONABILITY_BADGE_TONE: Record<ActionabilityTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-txt-muted",
  info: "text-primary",
};

function dirBadgeVariant(d: OpportunityMapRow["direction"]): "default" | "destructive" | "outline" {
  if (d === "BUY") return "default";
  if (d === "SELL") return "destructive";
  return "outline";
}

// Honest "scanned at" label. The backend stamps `generatedAt` at the real scan
// time and a cached read keeps that original stamp, so a Rescan within the cache
// window shows when the scan was REALLY run — never a fake "now".
function formatScannedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function BroadScanOpportunityMap({
  marketGroup,
  selectedSymbol,
  onPick,
  onScanned,
}: {
  marketGroup: UniverseId;
  selectedSymbol?: string | null;
  onPick?: (symbol: string) => void;
  // Reports whether a REAL scan exists for this map (server stamped a
  // `generatedAt` / scanned ≥1 symbol). The page folds this into its own
  // "scan exists" signal so the legacy results block below can never claim
  // "No scan run yet" while this map sits populated directly above it.
  onScanned?: (scanned: boolean) => void;
}) {
  const { name } = useAssistantName();
  const params = useMemo(
    () => ({
      marketGroup,
      ...(selectedSymbol ? { selectedSymbol } : {}),
    }),
    [marketGroup, selectedSymbol],
  );

  const { data, isLoading, isFetching, isError, refetch } = useGetMeOpportunityMap(params, {
    query: {
      queryKey: getGetMeOpportunityMapQueryKey(params),
      refetchOnWindowFocus: false,
    },
  });

  // Cross-surface feed-verdict reconciliation (Task #608). The broad scan runs at
  // its OWN scan timeframe (e.g. M5), but the user is looking at the selected
  // symbol's chart at the chart timeframe (e.g. 15m). The chart header & Ruby
  // Chart Read derive the selected symbol's feed verdict from `useSymbolTruth` at
  // the CHART timeframe and reconcile a lifted setup-aware verdict on top
  // (`resolveSelectedSymbolActionability`). We consume the SAME source here so a
  // broad-scan row can never read "Ready now / live data confirmed" for the very
  // symbol whose chart says "historical only / feed limited". DISPLAY-ONLY and
  // DOWNGRADE-ONLY: this can only make the selected row MORE conservative.
  const [chartTimeframe] = useScannerTimeframe();
  const selectedBare = bareSymbol((selectedSymbol ?? "").trim());
  const { scannerTruth: selectedTruth } = useSymbolTruth(selectedBare, chartTimeframe, {
    enabled: Boolean(selectedBare),
  });
  const selectedActionStore = useSelectedActionStore();
  const liftedSelectedRaw = selectedBare
    ? selectedActionStore.get(selectedBare, coerceVisibleTimeframe(chartTimeframe))
    : null;
  // CHECK_FAILED is a display-only marker for the header's Action cell — it is
  // NOT a feed verdict, so it must not participate in the feed-degraded cap
  // here (treat it as "no lifted verdict" and fall back to the data-only one).
  const liftedSelected = liftedSelectedRaw === "CHECK_FAILED" ? null : liftedSelectedRaw;
  const dataOnlySelected = selectedTruth?.consolidated.scannerActionability ?? null;
  const selectedVerdict = resolveSelectedSymbolActionability(liftedSelected, dataOnlySelected);
  // The cap we apply to the selected symbol's broad-scan row: only when the
  // selected chart's feed verdict is itself degraded (not live-confirmed).
  const selectedFeedCap =
    selectedVerdict && FEED_DEGRADED_VERDICTS.has(selectedVerdict) ? selectedVerdict : null;
  const selectedKey = symbolKey(selectedSymbol);
  const scanTimeframe = data?.timeframe ?? null;

  const rawMap = data?.map ?? null;
  // Defensive complete-payload gate (Task #609): a truthy-but-partial map — one
  // missing its `rows`, `categories`, or `best` block (a half-streamed or older
  // cached payload) — must NOT throw the panel into the route error boundary.
  // Only treat the map as usable when every block the body dereferences is
  // present; otherwise fall through to the honest empty state. A well-formed map
  // is unchanged.
  const map =
    rawMap != null &&
    Array.isArray(rawMap.rows) &&
    rawMap.categories != null &&
    rawMap.best != null
      ? rawMap
      : null;
  const bestVsSelected = data?.bestVsSelected ?? null;
  const scannedAtLabel = formatScannedAt(data?.generatedAt);
  // Skipped symbols + the universe total (M). `universeCount` is server-truth;
  // we fall back to scanned + skipped so an older cached payload still reconciles.
  const skippedSymbols = Array.isArray(data?.skippedSymbols) ? data.skippedSymbols : [];
  const universeCount =
    data?.universeCount ?? (map ? map.scannedCount + skippedSymbols.length : 0);

  // A real scan exists once the server stamps a `generatedAt` or reports ≥1
  // scanned symbol. Report it up so the page's "scan exists" gate stays honest.
  const mapScanned = Boolean(data?.generatedAt) || (map?.scannedCount ?? 0) > 0;
  useEffect(() => {
    onScanned?.(mapScanned);
  }, [onScanned, mapScanned]);

  return (
    <div className="rounded-2xl border border-border bg-card p-4" data-testid="opportunity-map">
      <div className="flex items-center gap-2.5">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
          <Radar className="h-[18px] w-[18px]" />
        </span>
        <div>
          <div className="text-[15px] font-semibold text-foreground">Opportunity Map</div>
          {map && (
            <div className="text-xs text-txt-muted" data-testid="opportunity-map-summary">
              {map.scannedCount} of {universeCount} scanned · {map.liveCount} on live data
              {skippedSymbols.length > 0 && (
                <span data-testid="opportunity-map-skipped-count"> · {skippedSymbols.length} skipped</span>
              )}
              {scannedAtLabel && <span data-testid="opportunity-map-scanned-at"> · scanned at {scannedAtLabel}</span>}
            </div>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-8 gap-1.5 px-2.5 text-xs"
          disabled={isFetching}
          onClick={() => void refetch()}
          data-testid="opportunity-map-refresh"
        >
          {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Rescan
        </Button>
      </div>

      {/* Best vs selected */}
      {bestVsSelected?.message && (
        <div
          className={`mt-3 rounded-xl border px-3 py-2 text-sm ${bestVsSelected.hasCleanerAlternative ? "border-primary/30 bg-primary/5" : "border-border bg-background/40"}`}
          data-testid="opportunity-map-best-vs-selected"
        >
          <div className="flex items-center gap-2">
            <span className="text-txt-secondary">{bestVsSelected.message}</span>
            {bestVsSelected.hasCleanerAlternative && bestVsSelected.best && onPick && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-7 gap-1 px-2 text-xs text-primary"
                onClick={() => onPick(bestVsSelected.best!.symbol)}
                data-testid="opportunity-map-switch"
              >
                Switch to {bestVsSelected.best.displayName} <ArrowRight className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      )}

      {data?.dataNote && (
        <div className="mt-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning" data-testid="opportunity-map-data-note">
          {data.dataNote}
        </div>
      )}

      {/* Skipped symbols — every universe symbol not in the scanned rows, with a
          concrete reason, so "N of M scanned" reconciles to the full universe and
          nothing is dropped silently (Task #600). */}
      {skippedSymbols.length > 0 && (
        <div
          className="mt-3 rounded-lg border border-border bg-background/40 px-3 py-2"
          data-testid="opportunity-map-skipped"
        >
          <div className="text-[11px] font-medium uppercase tracking-wide text-txt-muted">
            {skippedSymbols.length} of {universeCount} not scanned
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {skippedSymbols.map((s) => (
              <span
                key={s.symbol}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px]"
                data-testid={`opportunity-map-skipped-${s.symbol}`}
                title={`${s.displayName} — ${SKIPPED_REASON_COPY[s.reason]}`}
              >
                <span className="font-mono text-foreground">{s.displayName}</span>
                <span className="text-txt-muted">· {SKIPPED_REASON_COPY[s.reason]}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Best picks */}
      {map && <BestPicks best={map.best} onPick={onPick} />}

      {/* Body */}
      <div className="mt-3">
        {isLoading ? (
          <p className="text-sm text-txt-secondary">Scanning the markets…</p>
        ) : isError ? (
          <p className="text-sm text-danger" data-testid="opportunity-map-err">
            {name} couldn't scan the markets just now. Try again in a moment.
          </p>
        ) : !map || map.rows.length === 0 ? (
          <p className="text-sm text-txt-secondary" data-testid="opportunity-map-empty">
            No opportunities to show for this market group right now.
          </p>
        ) : (
          <div className="space-y-3">
            {CATEGORY_ORDER.map((cat) => {
              const rows = map.categories[cat] ?? [];
              if (rows.length === 0) return null;
              // Group-honesty cap: a group whose EVERY row lacks live data shows
              // honest degraded header wording instead of the bucket's (possibly
              // affirmative) category label — never the reverse. Display-only.
              const allDegraded = rows.every((r) => !r.hasLiveData);
              const meta = allDegraded ? DEGRADED_GROUP_META : CATEGORY_META[cat];
              return (
                <div
                  key={cat}
                  data-testid={`opportunity-map-cat-${cat}`}
                  data-group-degraded={allDegraded ? "true" : "false"}
                >
                  <div
                    className="flex items-center gap-2"
                    data-testid={`opportunity-map-cat-header-${cat}`}
                  >
                    <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
                    <span className="text-sm font-semibold text-foreground">{meta.label}</span>
                    <span className="text-xs text-txt-muted">· {meta.blurb}</span>
                    <span className="ml-auto text-xs text-txt-muted">{rows.length}</span>
                  </div>
                  <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                    {rows.map((r) => {
                      const isSelectedRow =
                        selectedKey != null && symbolKey(r.symbol) === selectedKey;
                      return (
                        <OpportunityRowCard
                          key={`${r.symbol}-${r.kind}`}
                          row={r}
                          onPick={onPick}
                          feedCapOverride={isSelectedRow ? selectedFeedCap : null}
                          scanTimeframe={isSelectedRow ? scanTimeframe : null}
                          chartTimeframe={isSelectedRow ? chartTimeframe : null}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function BestPicks({
  best,
  onPick,
}: {
  best: OpportunityBestPicks | null | undefined;
  onPick?: (symbol: string) => void;
}) {
  // Defensive (Task #609): tolerate a null/partial `best` block so a half-formed
  // payload can never throw here even though the call site already gates on a
  // complete map.
  const picks: { label: string; row: OpportunityMapRow | null }[] = [
    { label: "Best scalp", row: best?.bestScalp ?? null },
    { label: "Best retest", row: best?.bestRetest ?? null },
    { label: "Best momentum", row: best?.bestMomentum ?? null },
    { label: "Best reversal", row: best?.bestReversal ?? null },
  ];
  // Defensive truth cap: a "best pick" must have live data. Best picks are
  // already sourced from live candidates upstream, but never let a simulator-
  // derived (hasLiveData:false) row surface a direction/edge here either.
  const present = picks.filter((p) => p.row && p.row.hasLiveData);
  if (present.length === 0) return null;
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="opportunity-map-best-picks">
      {present.map(({ label, row }) => (
        <button
          key={label}
          type="button"
          onClick={() => row && onPick?.(row.symbol)}
          className="rounded-xl border border-border bg-background/40 p-2.5 text-left hover:border-primary/40"
          data-testid={`opportunity-map-best-${label.replace(/\s+/g, "-").toLowerCase()}`}
        >
          <div className="text-[10px] uppercase tracking-wide text-txt-muted">{label}</div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="text-sm font-semibold text-foreground">{row!.displayName}</span>
            <Badge variant={dirBadgeVariant(row!.direction)} className="text-[10px]">{row!.direction}</Badge>
          </div>
          <div className="text-[11px] text-txt-muted">Edge {Math.round(row!.edgeScore)}</div>
        </button>
      ))}
    </div>
  );
}

function OpportunityRowCard({
  row,
  onPick,
  feedCapOverride = null,
  scanTimeframe = null,
  chartTimeframe = null,
}: {
  row: OpportunityMapRow;
  onPick?: (symbol: string) => void;
  // Cross-surface feed cap for the SELECTED symbol's row (Task #608). When the
  // selected chart's own feed verdict is degraded (FEED_LIMITED / ANALYSIS_ONLY /
  // MARKET_CLOSED), the broad-scan row for that same symbol must not out-claim it.
  // Only ever set for the selected row, and only to a feed-degraded verdict.
  feedCapOverride?: ScannerActionability | null;
  // The broad scan's scan timeframe (API form, e.g. "M5") and the selected
  // chart's timeframe (bus form, e.g. "15m"). Set only for the selected row, so
  // a timeframe mismatch can be surfaced honestly on that card.
  scanTimeframe?: string | null;
  chartTimeframe?: string | null;
}) {
  // The ONE shared verdict for this row — drives the data-actionability attr, the
  // verdict badge, and the guidance copy below so all three agree (Task #600).
  const ownAction = rowActionability(row);
  // DOWNGRADE-ONLY reconciliation: the selected chart's degraded feed verdict
  // replaces the row's own verdict ONLY when it is at least as conservative, so
  // this can never grant readiness — it can only pull the row down to match the
  // chart header / Ruby Chart Read for the same symbol (Task #608).
  const action =
    feedCapOverride &&
    ACTIONABILITY_SEVERITY[feedCapOverride] >= ACTIONABILITY_SEVERITY[ownAction]
      ? feedCapOverride
      : ownAction;
  const feedCapApplied = action !== ownAction;
  // Display-honesty cap: a row WITHOUT live data — or one pulled down to a
  // feed-degraded verdict by the selected-chart reconciliation — shows ONLY its
  // symbol and the awaiting/limited state. The scanner falls back to the in-memory
  // simulator to compute a direction/edge for non-synthetic symbols that have no
  // feed (tagged dataSource:"SIMULATOR", hasLiveData:false, non-tradeable). Those
  // simulator-derived numbers must NEVER surface here — not capped, not labeled.
  // A row earns its direction badge + Edge/Entry/Feed scores only when it has live
  // data AND its final verdict isn't feed-degraded. The render truth-cap test makes
  // the no-data "direction + scores" state unrepresentable.
  const live = row.hasLiveData && !FEED_DEGRADED_VERDICTS.has(action);
  const actionUi = SCANNER_ACTIONABILITY_UI[action];
  // When the row has feed data but the SELECTED chart's verdict pulled it down,
  // the honest non-live label is "feed not live-confirmed" (lower-case, matching
  // the chart copy) rather than "No live data" (which would be untrue for a row
  // that does carry scan data).
  const awaitingLabel = feedCapApplied && row.hasLiveData ? "Feed not live-confirmed" : "No live data";
  const showTfNote = !sameTimeframe(scanTimeframe, chartTimeframe);
  return (
    <button
      type="button"
      onClick={() => onPick?.(row.symbol)}
      className="rounded-xl border border-border bg-background/40 p-2.5 text-left hover:border-primary/40"
      data-testid={`opportunity-row-${row.symbol}`}
      data-actionability={action}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-semibold text-foreground">{row.displayName}</span>
        {live ? (
          <Badge
            variant={dirBadgeVariant(row.direction)}
            className="text-[10px]"
            data-testid={`opportunity-row-direction-${row.symbol}`}
          >
            {row.direction}
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="text-[10px] text-warning"
            data-testid={`opportunity-row-awaiting-${row.symbol}`}
          >
            {awaitingLabel}
          </Badge>
        )}
        {/* The ONE readiness source for this row is the shared verdict badge
            (Task #600). The backend `row.stageLabel` (the section's own category
            label, already shown in the group header above) is intentionally NOT
            rendered here — two readiness phrases on one card (e.g. a "Ready now"
            stage beside a "Wait for confirmation" verdict) could disagree. */}
        <Badge
          variant="outline"
          className={`ml-auto text-[10px] ${ACTIONABILITY_BADGE_TONE[actionUi.tone]}`}
          data-testid={`opportunity-row-verdict-${row.symbol}`}
        >
          {actionUi.label}
        </Badge>
      </div>
      {/* Cross-surface timeframe honesty (Task #608): the broad scan runs at its
          OWN timeframe; if that differs from the selected chart's timeframe, say
          so explicitly so the user understands why the scan row and the chart can
          read differently for the same symbol. Only shown on the selected row. */}
      {showTfNote && scanTimeframe && chartTimeframe && (
        <div
          className="mt-1 text-[11px] leading-snug text-txt-muted"
          data-testid={`opportunity-row-tf-note-${row.symbol}`}
        >
          Scanned on {scanTimeframe} · chart is on{" "}
          {toApiTimeframe(normalizeChartTimeframe(chartTimeframe))}
        </div>
      )}
      {live && (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-txt-muted" data-testid={`opportunity-row-stats-${row.symbol}`}>
          <span>Edge {Math.round(row.edgeScore)}</span>
          <span>· Entry {Math.round(row.entryQuality)}</span>
          {/* Feed-readiness, NOT a per-symbol execution score: this value is
              derived purely from the row's feed state (executionQualityFor —
              live > delayed > history > stale > awaiting > sim=0), so it is
              labelled "Feed" to stay honest rather than implying a fabricated
              per-trade execution quality. */}
          <span>· Feed {Math.round(row.executionQuality)}</span>
          {row.newsRisk !== "none" && <span className="text-warning">· news {row.newsRisk}</span>}
        </div>
      )}
      {/* Reason can echo the simulator read for a no-data row, so only show it
          when the row has live data; otherwise the honest awaiting message
          (bestAction) carries the state. */}
      {live && row.reason && (
        <div className="mt-1 text-[11px] leading-snug text-txt-muted" data-testid={`opportunity-row-reason-${row.symbol}`}>
          {row.reason}
        </div>
      )}
      {/* The ONE action verdict's guidance line — always rendered, sourced from
          the shared UI-copy map (Task #600), never the per-row bestAction prose,
          so the broad-scan row, the cards, and the header can never disagree
          about what to do with this market. */}
      <div
        className="mt-1 text-xs leading-snug text-txt-secondary"
        data-testid={`opportunity-row-action-${row.symbol}`}
      >
        {actionUi.copy}
      </div>
    </button>
  );
}

export default BroadScanOpportunityMap;
