import { useEffect, useMemo, useState } from "react";
import { markActionStart, markUiFeedback, markActionEnd } from "@/lib/perf";
import { useGetAaciCohesion, getGetAaciCohesionQueryKey, type AaciCohesionItem } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Radar, Play, Square, RefreshCw, Send, TrendingUp, TrendingDown, Sliders, Target, Layers, Thermometer, ArrowRight } from "lucide-react";
import { Link } from "wouter";
import { SetupQualityBadge } from "@/components/trading/SetupQualityBadge";
import { RubySetupReason } from "@/components/scanner/RubySetupReason";
import { ScannerTimingBadges, type ScannerTimingContext } from "@/components/scanner/ScannerTimingBadges";
import { isGoldMode } from "@workspace/domain/market";
import { ScannerTradeModal } from "@/components/scanner/ScannerTradeModal";
import {
  RecentScannerTrades,
  RECENT_SCANNER_TRADES_SECTION_DESCRIPTION,
} from "@/components/scanner/RecentScannerTrades";
import { MasterLiveAccessBanner } from "@/components/live/MasterLiveAccessGuard";
import { SelectedMarketPanel } from "@/components/scanner/SelectedMarketPanel";
import { ScannerDataHealthPanel } from "@/components/scanner/ScannerDataHealthPanel";
import { HighImpactEventBanner } from "@/components/news/HighImpactEventBanner";
import { SymbolExplorer } from "@/components/scanner/SymbolExplorer";
import { ScannerChartPanel } from "@/components/scanner/ScannerChartPanel";
import { TradeHealthPanel } from "@/components/live/TradeHealthPanel";
import { ScannerHeaderSummary } from "@/components/scanner/ScannerHeaderSummary";
import { RubyReadStoreProvider } from "@/components/scanner/rubyReadStore";
import { SelectedActionStoreProvider } from "@/components/scanner/selectedActionStore";
import { SectionErrorBoundary } from "@/components/layout/SectionErrorBoundary";
import { PageTabs } from "@/components/ui/PageTabs";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import { EmptyState } from "@/components/ui/EmptyState";
import { CompactAlert } from "@/components/ui/CompactAlert";
import { useChartSymbol, bareSymbol, setChartSymbol } from "@/lib/use-chart-symbol";
import { resolveSymbol } from "@/lib/symbolRegistry";
import { useViewMode } from "@/hooks/useViewMode";
import { RubyScalpFocusCard } from "@/components/scanner/RubyScalpFocusCard";
import { RubyMarketReadCard } from "@/components/scanner/RubyMarketReadCard";
import { TimingIntelligenceCard } from "@/components/scanner/TimingIntelligenceCard";
import { ScannerReadGate } from "@/components/scanner/ScannerReadGate";
import { BroadScanOpportunityMap } from "@/components/scanner/BroadScanOpportunityMap";
import { RubyScalpScan } from "@/components/scanner/RubyScalpScan";
import { RubyScalpBasketPanel } from "@/components/scanner/RubyScalpBasketPanel";
import { RubyScalpReviewPanel } from "@/components/scanner/RubyScalpReviewPanel";
import { STATUS_COLORS } from "@/lib/design-tokens";
import { safeJson } from "@/lib/api/safeJson";
import { SCANNER_DEGRADED_MESSAGE } from "@/lib/scannerResilience";
import type { ScalpResult } from "@workspace/api-client-react";

type Opp = {
  symbol: string; timeframe: string;
  bias: string; recommendedAction: string;
  // signalStrength is the canonical wire name; confidenceScore is the
  // deprecated dual-emit alias (kept for the live-intent submit payload).
  // Numbers are null on a server-masked simulator row (withheld, not measured):
  // the card renders "—" for them, never a fake measured 0.
  setupType: string; signalStrength?: number | null; confidenceScore: number | null; riskScore: number | null;
  entrySniperScore: number | null; riskRewardRatio: number | null;
  reasonForTrade: string; reasonToAvoid: string;
  rulesPassed: string[]; rulesFailed: string[];
  statusBadge: string;
  opportunity: { score: number | null; label: string };
  entry: number | null; stopLoss: number | null; takeProfit: number | null;
  // True on a simulator row masked for this (non-privileged) viewer: every
  // score/level above is withheld. Trade actions must never seed from it.
  withheld?: boolean;
  timingContext?: ScannerTimingContext;
};

// Mirrors the server's `MANUAL_SCAN_COOLDOWN_MS` (per-user manual-scan cooldown
// in `api-server/src/lib/concurrency/rateLimit.ts`). Used only to seed the
// Scan-button cooldown countdown after a *successful* scan, where the success
// response carries no timer. The 429 envelope's `retryAfterMs` remains the
// authoritative source and reconciles any drift if the constants diverge.
const MANUAL_SCAN_COOLDOWN_MS = 7_000;

type UniverseId = "all" | "forex" | "metals" | "indices" | "crypto" | "synthetic" | "full";
type UniverseInfo = { id: UniverseId; label: string; symbols: string[]; available: boolean; note: string | null };

/** The opportunity-map endpoint groups equities/indices under "stocks" and has
 *  no "full" — map the scanner universe onto its accepted set. */
type OpportunityMapGroup = "all" | "forex" | "metals" | "crypto" | "stocks" | "synthetic";
function opportunityMapGroup(u: UniverseId): OpportunityMapGroup {
  if (u === "indices") return "stocks";
  if (u === "full") return "all";
  return u;
}

// ARX 6.0: status chips compose STATUS_COLORS (design-tokens.ts) so every
// tone renders correctly in both themes — no raw Tailwind palette classes.
const BADGE_COLORS: Record<string, string> = {
  HOT_SETUP: STATUS_COLORS.success.badge,
  WATCHLIST: "bg-primary/10 text-primary border-primary/25",
  WAIT_FOR_CONFIRMATION: STATUS_COLORS.warning.badge,
  REJECTED_BY_RISK: STATUS_COLORS.danger.badge,
  CHOPPY_MARKET: STATUS_COLORS.neutral.badge,
  LOW_CONFIDENCE: STATUS_COLORS.warning.badge,
  SPREAD_TOO_HIGH: STATUS_COLORS.danger.badge,
  PENDING_MT5_CONNECTION: STATUS_COLORS.premium.badge,
};

// Plain-language labels for the scanner status badges. Raw UPPER_SNAKE
// values must never reach normal users — they go in the data attribute
// for tests/devtools only, and the visible chip uses these strings.
const BADGE_LABELS: Record<string, string> = {
  HOT_SETUP: "Hot setup",
  WATCHLIST: "Watchlist",
  WAIT_FOR_CONFIRMATION: "Wait for confirmation",
  REJECTED_BY_RISK: "Risk too high",
  CHOPPY_MARKET: "Choppy market",
  LOW_CONFIDENCE: "Low confidence",
  SPREAD_TOO_HIGH: "Spread too wide",
  PENDING_MT5_CONNECTION: "Waiting for connection",
};

const LABEL_COLORS: Record<string, string> = {
  ELITE: STATUS_COLORS.premium.badge,
  STRONG: STATUS_COLORS.success.badge,
  ACCEPTABLE: "bg-primary/10 text-primary border-primary/25",
  WEAK: STATUS_COLORS.warning.badge,
  REJECT: STATUS_COLORS.danger.badge,
};

/** Left-edge accent for a result card, keyed to the opportunity verdict. */
function oppEdgeClass(label: string): string {
  if (label === "ELITE" || label === "STRONG") return "border-l-success";
  if (label === "REJECT") return "border-l-danger";
  return "border-l-primary";
}

// Scanner AACI cohesion badge accents (advisory/display only — never reorders
// or routes). Tone comes straight from the read-only batch cohesion endpoint.
const COHESION_SHELL: Record<AaciCohesionItem["cohesionTone"], string> = {
  ok: STATUS_COLORS.success.badge,
  muted: STATUS_COLORS.neutral.badge,
  warn: STATUS_COLORS.warning.badge,
  danger: STATUS_COLORS.danger.badge,
};
const COHESION_MAX_SYMBOLS = 12;

// Shared fetch helper for the scanner page. It checks `r.ok` and throws an
// error carrying the parsed response body (status + server message) so callers
// can surface a real failure instead of silently discarding a 403 body. No
// client-supplied role header is sent — role is resolved server-side from the
// session cookie; a spoofed role header is dead, misleading code on a
// user-facing page (rejected in production, superseded by the real session).
// Mirror of liveIntent.ts TESTER_CAPS. The endpoint hard-rejects anything
// above these, so the UI submits exactly them and says so rather than
// pretending the capture carries the user's own sizing.
const TESTER_INTENT_LOT = 0.01;
const TESTER_INTENT_MAX_LOSS_USD = 5;

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    /* non-JSON / empty body — leave body null */
  }
  if (!r.ok) {
    const b = body as { error?: unknown; message?: unknown } | null;
    const serverMsg =
      (b && (typeof b.error === "string" ? b.error : typeof b.message === "string" ? b.message : null)) ?? null;
    const e = new Error(serverMsg ?? `Request failed (${r.status})`) as Error & {
      status?: number;
      body?: unknown;
    };
    e.status = r.status;
    e.body = body;
    throw e;
  }
  return body;
}

/**
 * Timeframe the scalp engine actually reads on. Mirrors SCALP_TIMEFRAME in
 * api-server/src/lib/scalp/scalpServiceInputs.ts — kept as a named constant so
 * the ticket's stamp is obviously tied to the engine rather than a loose
 * literal that can drift out of sync again.
 */
const SCALP_TICKET_TIMEFRAME = "M5";

// Convert a shared-engine ScalpResult into the SignalContext the existing
// gated trade ticket consumes. This carries the scalp's symbol/direction/
// entry/SL/main-TP/suggested-lot into the SAME ScannerTradeModal used
// everywhere else — no new trade path, every server safety gate re-runs on
// submit.
export function scalpResultToSignal(r: ScalpResult) {
  const entry = r.entryZone
    ? (r.entryZone.from + r.entryZone.to) / 2
    : (r.currentPrice ?? undefined);
  return {
    symbol: r.symbol,
    // The engine reads and reasons on M5 (SCALP_TIMEFRAME). This used to stamp
    // "M1", so the journal, attribution and review all recorded a timeframe the
    // setup was never evaluated on (Theme D1).
    timeframe: SCALP_TICKET_TIMEFRAME,
    recommendedAction: r.direction ?? "BUY",
    bias: r.direction ?? "NEUTRAL",
    signalStrength: r.qualityScore,
    confidenceScore: r.qualityScore,
    reasonForTrade: r.plainEnglishReason,
    reasonToAvoid: r.riskWarning ?? r.noTradeReason ?? undefined,
    setupType: r.scalpType,
    entry,
    stopLoss: r.stopLoss ?? undefined,
    takeProfit: r.takeProfit.main ?? undefined,
    // The engine's real risk-based size, computed from broker truth
    // (tickValue/tickSize, clamped to min/max/step). Dropping it meant the
    // modal fell back to a hardcoded 0.02 and the size actually sent to the
    // broker bore no relation to the sizing shown to the user.
    //
    // null is meaningful and passed through as null: the engine deliberately
    // refuses to size on insufficient margin, a flame kill, or below-min-lot
    // risk, and that refusal must not become a fabricated number.
    suggestedLot: r.suggestedLot ?? null,
  };
}

/**
 * Simple-first scanner page. Four tabs:
 *  Focus    — selected market + Ruby read + safety banners. Default tab.
 *  Results  — opportunity cards from the running scan.
 *  Symbols  — full SymbolExplorer with search + collapsible groups.
 *  Advanced — scan universe selector, scan engine controls, feed status,
 *             scanner universe symbol list (collapsible), recent commands.
 *
 * Nothing is removed — only reorganised. Universe controls / scanner
 * engine controls / feed config notes / recent commands all still live in
 * Advanced. The default Focus view stays calm: one selected-market card,
 * one Ruby read, no chip walls.
 */
export default function MarketScanner() {
  const [universe, setUniverse] = useState<UniverseId>("all");
  const [universes, setUniverses] = useState<UniverseInfo[]>([]);
  const [status, setStatus] = useState<{
    running: boolean; opportunityCount: number; lastScanAt: string | null;
    universe?: UniverseId; universeSymbols?: string[]; feedNote?: string;
  } | null>(null);
  const [opps, setOpps] = useState<Opp[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // Non-error outcome banner (currently the operator-review capture result).
  // Rendered through CompactAlert like every other message on this page — a
  // native alert() with a raw UPPER_SNAKE enum in it violated the page's own
  // rule that raw enums never reach users (see BADGE_LABELS above).
  const [notice, setNotice] = useState<
    { tone: "info" | "warning"; title: string; description: string } | null
  >(null);
  // Scan-button cooldown (Task #565). After a successful scan we proactively
  // disable the button for the per-user cooldown window and show a live
  // countdown, so a too-fast retry is prevented up front rather than only
  // surfacing the 429 honest-error after the click. `cooldownUntil` is an
  // absolute epoch-ms deadline; `cooldownSecs` is the ticking seconds-left the
  // button renders. The deadline is seeded from the server's reported
  // `retryAfterMs` whenever we have it (the 429 envelope is authoritative and
  // reconciles any client/server drift); on a successful scan we fall back to
  // the mirrored client constant since the success response carries no timer.
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownSecs, setCooldownSecs] = useState(0);
  // In-progress state for the user-triggered "Retry now" action on the scanner
  // error banner. Separate from `busy` (engine controls) so a manual retry never
  // disables/contends with start/stop/scan.
  const [retrying, setRetrying] = useState(false);
  // PART A (Task #573) — distinguish NEVER-SCANNED from SCANNED-EMPTY. `load()`
  // on mount only reads any existing engine feed; until the user actually runs a
  // scan (Scan button or a universe switch) an empty feed means "no scan run
  // yet", NOT "scan found nothing". Flipped true after a scan/universe attempt
  // completes so the empty state can tell the honest difference.
  const [hasScanned, setHasScanned] = useState(false);
  // Whether the broad opportunity map directly above the results block holds a
  // real scan. Folded into `scanExists` so the legacy results block can never
  // claim "No scan run yet" while the map renders populated results.
  const [mapScanned, setMapScanned] = useState(false);
  const [tradeTarget, setTradeTarget] = useState<{ opp: Opp; side: "BUY" | "SELL" } | null>(null);
  const [scalpTrade, setScalpTrade] = useState<{ result: ScalpResult; side: "BUY" | "SELL" } | null>(null);
  // Advanced analysis surfaces (Trade Review / Market Replay / Backtesting)
  // are admin-only routes now. Hide their quick-links from normal users so a
  // result card never deep-links into a page their session can't reach.
  const { realIsAdmin } = useViewMode();

  // AACI cohesion (advisory/display only) for the visible candidates. Fetched
  // OFF the 5s scan loop with a long staleTime so it never adds load to the hot
  // scan path. Per-user, read-only, fail-open (missing symbols are simply not
  // annotated). Caps at COHESION_MAX_SYMBOLS to honour the endpoint contract;
  // candidates beyond the cap render with no cohesion annotation rather than a
  // fabricated one. NEVER reorders, re-ranks, or routes — display only.
  const cohesionSymbols = useMemo(() => {
    const seen: string[] = [];
    for (const o of opps) {
      if (!seen.includes(o.symbol)) seen.push(o.symbol);
      if (seen.length >= COHESION_MAX_SYMBOLS) break;
    }
    return seen;
  }, [opps]);
  const cohesionCsv = cohesionSymbols.join(",");
  const { data: cohesionData } = useGetAaciCohesion(
    { symbols: cohesionCsv },
    {
      query: {
        queryKey: getGetAaciCohesionQueryKey({ symbols: cohesionCsv }),
        enabled: cohesionCsv.length > 0,
        staleTime: 60_000,
        refetchInterval: 120_000,
        refetchIntervalInBackground: false,
        retry: false,
      },
    },
  );
  const cohesionMap = useMemo(() => {
    const m = new Map<string, AaciCohesionItem>();
    for (const it of cohesionData?.results ?? []) m.set(it.symbol, it);
    return m;
  }, [cohesionData]);

  // Load universe definitions once. safeJson never throws — a degraded feed
  // simply leaves the universe list untouched (no fabricated entries).
  useEffect(() => {
    (async () => {
      const res = await safeJson<{ universes?: UniverseInfo[] }>(
        "/api/market-scanner/universes",
      );
      if (res.ok) setUniverses(res.data.universes ?? []);
      else console.debug("[MarketScanner] universes read failed", res.kind, res.status, res.message);
    })();
  }, []);

  async function load() {
    // Both reads go through safeJson: a 502 / empty / truncated body comes back
    // as a typed failure instead of an uncaught SyntaxError. On any failure we
    // keep the prior status/opportunities (no wipe on a transient blip), show
    // honest degraded copy, and route the raw detail to the operator console.
    const [s, o] = await Promise.all([
      safeJson<{
        running: boolean; opportunityCount: number; lastScanAt: string | null;
        universe?: UniverseId; universeSymbols?: string[]; feedNote?: string;
      }>("/api/market-scanner/status"),
      safeJson<{ opportunities?: Opp[] }>("/api/market-scanner/opportunities?limit=40"),
    ]);
    // Narrow each result independently so TypeScript keeps the failure variant
    // (the union can't be correlated through a shared `f` ternary).
    if (!s.ok) {
      console.debug("[MarketScanner] status read failed", s.kind, s.status, s.message);
      setErr(SCANNER_DEGRADED_MESSAGE);
      return;
    }
    if (!o.ok) {
      console.debug("[MarketScanner] opportunities read failed", o.kind, o.status, o.message);
      setErr(SCANNER_DEGRADED_MESSAGE);
      return;
    }
    setErr("");
    setStatus(s.data);
    const universeSyms: string[] = s.data?.universeSymbols ?? [];
    const all: Opp[] = o.data.opportunities ?? [];
    setOpps(universeSyms.length ? all.filter((x) => universeSyms.includes(x.symbol)) : all);
  }
  // Tick the Scan-button cooldown countdown. A single 250ms interval (so the
  // displayed seconds update promptly) recomputes the remaining whole seconds
  // from the absolute deadline, then clears itself when the deadline passes.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) { setCooldownSecs(0); return; }
    const tick = () => {
      const remaining = cooldownUntil - Date.now();
      setCooldownSecs(remaining > 0 ? Math.ceil(remaining / 1000) : 0);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const scanCoolingDown = cooldownSecs > 0;

  // User-triggered immediate retry from the scanner error banner. Re-runs the
  // same `load()` the 5s poll uses; `load()` clears `err` on success so the
  // banner self-dismisses. Guarded against double-fire while in progress.
  async function retryNow() {
    if (retrying) return;
    setRetrying(true);
    try {
      await load();
    } finally {
      setRetrying(false);
    }
  }
  // Polling — paused when the tab is hidden, and we resync immediately on
  // visibility return. Without this the scanner page burns two GETs every
  // 5s for every backgrounded tab and the user comes back to stale data
  // anyway because the next tick is up to 5s away. See
  // `.agents/memory/perf-poll-and-invalidation-rules.md`.
  useEffect(() => {
    void load();
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id != null) return;
      id = setInterval(load, 5000);
    };
    const stop = () => { if (id != null) { clearInterval(id); id = null; } };
    const onVis = () => {
      if (document.hidden) {
        stop();
      } else {
        // Resync once on return so we don't show ≤5s-stale results.
        void load();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  // Surface any thrown error through the existing `err` state / CompactAlert.
  function reportErr(e: unknown) {
    setErr(e instanceof Error ? e.message : String(e));
  }

  // Shared 429 handler for the rate-limited /market-scanner/scan endpoint.
  // Both the Scan button and the admin universe-switch hit the SAME per-user
  // cooldown, so both must surface the identical honest "Scanning too fast"
  // copy and reconcile the cooldown countdown to the server's authoritative
  // `retryAfterMs`. Returns true if the error was a handled 429 so the caller
  // skips the raw-error fallback.
  function handleScanCooldown(e: unknown): boolean {
    const status = (e as { status?: number } | null)?.status;
    if (status !== 429) return false;
    const body = (e as { body?: { retryAfterMs?: unknown } } | null)?.body;
    const retryMs = typeof body?.retryAfterMs === "number" ? body.retryAfterMs : 0;
    const secs = retryMs > 0 ? Math.ceil(retryMs / 1000) : 0;
    // Reconcile the countdown to the server's authoritative remaining wait.
    if (retryMs > 0) setCooldownUntil(Date.now() + retryMs);
    setErr(secs > 0
      ? `Scanning too fast — try again in ${secs}s.`
      : "Scanning too fast — try again in a moment.");
    return true;
  }

  async function start() {
    setErr("");
    setBusy(true);
    try {
      await api("/api/market-scanner/start", { method: "POST", body: JSON.stringify({ intervalMs: 10_000, universe }) });
      await load();
    } catch (e) { reportErr(e); }
    finally { setBusy(false); }
  }
  async function stop() {
    setErr("");
    setBusy(true);
    try {
      await api("/api/market-scanner/stop", { method: "POST" });
      await load();
    } catch (e) { reportErr(e); }
    finally { setBusy(false); }
  }
  async function scan()  {
    // PART B — Scanner.Scan timing. Targets: button feedback <50ms,
    // first results <1s. setBusy() is the user-visible loading state.
    //
    // Every authenticated user now triggers a real one-shot Broad Scan
    // (Task #562): the POST runs the scan server-side (per-user rate-limited,
    // per-viewer projected), then `load()` refreshes the visible feed. A
    // too-fast retry comes back as a clean 429 we surface honestly — never a
    // raw error and never a silent no-op. The always-on engine (Start/Stop)
    // stays operator-only.
    const id = markActionStart("scanner.scan", { page: "market-scanner" });
    setErr("");
    setBusy(true);
    markUiFeedback(id);
    try {
      await api("/api/market-scanner/scan", { method: "POST", body: JSON.stringify({ universe }) });
      await load();
      // Proactively disable the Scan button for the cooldown window so the next
      // click can't trip the 429. Seeded from the mirrored client constant
      // (success carries no server timer); the 429 path below corrects it if it
      // ever fires.
      setCooldownUntil(Date.now() + MANUAL_SCAN_COOLDOWN_MS);
    } catch (e) {
      if (!handleScanCooldown(e)) reportErr(e);
    } finally {
      // A scan was attempted this session — an empty feed now reads as
      // SCANNED-EMPTY ("found nothing"), not NEVER-SCANNED.
      setHasScanned(true);
      setBusy(false);
      markActionEnd(id);
    }
  }

  async function changeUniverse(next: UniverseId) {
    // PART D fix — previously this called `scan` THEN `load` sequentially
    // and pre-cleared `opps` (which caused an empty-state flash). Now we
    // fire scan + status/opportunities in parallel and only clear the
    // visible cards if the scan itself succeeded. Two roundtrips become
    // one wall-clock wait.
    const id = markActionStart("scanner.changeUniverse", { page: "market-scanner" });
    setUniverse(next);
    setErr("");
    setBusy(true);
    markUiFeedback(id);
    try {
      // Admins kick the engine scan first (server queues the work) so fresh
      // opportunities are written; non-admins just re-read the USER-allowed
      // feed for the new universe. Either way we read status + opportunities
      // in the SAME tick and never silently swallow a 403.
      if (realIsAdmin) {
        await api("/api/market-scanner/scan", { method: "POST", body: JSON.stringify({ universe: next }) });
      }
      await load();
    } catch (e) {
      // A too-fast universe switch hits the SAME per-user scan cooldown as the
      // Scan button, so surface the identical honest "Scanning too fast" copy
      // (and reconcile the shared countdown) rather than a raw 429 error.
      if (!handleScanCooldown(e)) reportErr(e);
    } finally {
      // A universe switch re-reads/re-scans the feed — treat an empty result as
      // SCANNED-EMPTY, not NEVER-SCANNED.
      setHasScanned(true);
      setBusy(false);
      markActionEnd(id);
    }
  }

  // POST /api/live-intent/submit is a TESTER CAPTURE, not an order. It writes a
  // live_intents row and a vault event with brokerOrderPlaced:false and never
  // reaches a broker; the only surface that reads the queue (/live-intent-queue)
  // is admin-only. So the control is admin-only too, is labelled for what it
  // does, states the fixed tester caps it submits under (liveIntent.ts
  // TESTER_CAPS: 0.01 lots / $5 max loss — the server rejects anything larger),
  // reports the server's own sentence instead of a raw enum in a native alert,
  // and can no longer throw an unhandled rejection on a 400/403/500.
  async function captureForOperatorReview(o: Opp) {
    setErr("");
    setNotice(null);
    try {
      const r = await api("/api/live-intent/submit", {
        method: "POST",
        body: JSON.stringify({
          source: "AI_ASSIST", symbol: o.symbol,
          direction: o.recommendedAction === "SELL" ? "SELL" : "BUY",
          lotSize: TESTER_INTENT_LOT, stopLoss: o.stopLoss, takeProfit: o.takeProfit,
          maxLossUsd: TESTER_INTENT_MAX_LOSS_USD, confidenceScore: o.confidenceScore,
          reasonForTrade: o.reasonForTrade,
        }),
      }) as { reason?: unknown; riskCheckPassed?: unknown } | null;
      const serverReason = typeof r?.reason === "string" ? r.reason : null;
      setNotice({
        tone: r?.riskCheckPassed === false ? "warning" : "info",
        title: `${o.symbol} captured for operator review — no order was placed`,
        description:
          serverReason ??
          "The capture was recorded. No broker order was placed.",
      });
    } catch (e) {
      reportErr(e);
    }
  }

  const activeUniverse = universes.find((u) => u.id === universe);
  const universeAvailable = activeUniverse?.available ?? true;
  const universeNote = activeUniverse?.note;

  // Used by the Symbols tab so picking a symbol there immediately updates
  // the chart / trade ticket / Focus tab via the global chart symbol bus.
  const [chartSym] = useChartSymbol();
  const symbolsTabActive = (() => {
    const bare = bareSymbol(chartSym || "EURUSD").toUpperCase();
    return resolveSymbol(bare)?.canonicalSymbol ?? "EURUSD";
  })();

  // ---------- Scalp handlers ----------------------------------------------

  // Open the gated trade ticket pre-filled from a scalp result.
  const openScalpTrade = (r: ScalpResult) => {
    setScalpTrade({ result: r, side: r.direction === "SELL" ? "SELL" : "BUY" });
  };

  // Load a ranked/built pick onto the shared chart bus (canonicalised).
  const handleScalpPick = (r: ScalpResult) => {
    const bare = bareSymbol(r.symbol).toUpperCase();
    const canonical = resolveSymbol(bare)?.canonicalSymbol ?? r.symbol;
    setChartSymbol(canonical);
  };

  // Load a symbol (by name) onto the shared chart bus (canonicalised).
  const handleSymbolPick = (symbol: string) => {
    const bare = bareSymbol(symbol).toUpperCase();
    const canonical = resolveSymbol(bare)?.canonicalSymbol ?? symbol;
    setChartSymbol(canonical);
  };

  // ---------- Tab contents -------------------------------------------------

  const focusTab = (
    <div className="space-y-4">
      <MasterLiveAccessBanner />
      <HighImpactEventBanner />
      {/* Global market heat lives on the Market Heat Map page now (surface
          consolidation item A — heat is ONE surface). A compact link keeps
          at-a-glance heat one tap away from where trades are placed. */}
      <Link
        href="/market-heat-map"
        className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs text-txt-secondary hover:border-primary/40 hover:text-foreground"
        data-testid="scanner-global-heat-link"
      >
        <Thermometer className="h-3.5 w-3.5 text-muted-foreground" />
        Global market heat — country, currency and synthetic heat on the Market Heat Map
        <ArrowRight className="ml-auto h-3.5 w-3.5" />
      </Link>
      <SelectedMarketPanel />
      <ScannerDataHealthPanel />
      <RubyScalpBasketPanel />
      <RubyScalpReviewPanel />
      <RubyScalpFocusCard symbol={symbolsTabActive} onBuild={openScalpTrade} />
      <ScannerReadGate symbol={symbolsTabActive} />
      <TimingIntelligenceCard symbol={symbolsTabActive} />
      <RubyMarketReadCard symbol={symbolsTabActive} />
    </div>
  );

  // A scan genuinely EXISTS when either this session ran one (`hasScanned`) OR
  // the server reports a real `lastScanAt` (Task #600). The session flag alone
  // lied on a fresh page load: the always-on engine / a prior scan can have
  // produced server results, so "No scan run yet" must defer to server truth —
  // otherwise the page can show "16 scanned" in the opportunity map above while
  // the legacy results block simultaneously claims no scan has run (contradiction
  // #3). Server scan-existence is authoritative; the client flag only fast-paths
  // the in-session case before the next poll lands.
  const scanExists = hasScanned || Boolean(status?.lastScanAt) || mapScanned;

  const resultsBlock = (
    <div className="space-y-3">
      {status?.lastScanAt && (
        <p className="text-xs tabular-nums text-muted-foreground">
          Last scan {new Date(status.lastScanAt).toLocaleTimeString()} · {opps.length} opportunit{opps.length === 1 ? "y" : "ies"} in {activeUniverse?.label ?? "current universe"}
        </p>
      )}

      {!universeAvailable ? (
        <CompactAlert
          tone="warning"
          title="Live broker feed required"
          description={universeNote ?? "This universe needs a live broker feed before the scanner can analyze it."}
          details={
            <p>
              The simulator does not generate candles for these symbols. We don't fabricate results —
              pick another universe above or connect your broker bridge.
            </p>
          }
          testId="scanner-feed-required"
        />
      ) : opps.length === 0 ? (
        <Card><CardContent className="p-6 text-sm text-muted-foreground" data-testid="scanner-empty-state">
          {/* Blessed empty-state shape (DESIGN_SPEC §5) — the muted icon well
              frames the SAME pinned honesty copy (never-scanned vs scanned-empty
              vs degraded); testids and sentences are asserted by
              market-scanner.empty-state.test.tsx and stay verbatim. */}
          <EmptyState
            icon={Radar}
            compact
            title={
              err ? (
                // A degraded status/opportunities poll must NOT masquerade as an empty
                // market (Task #600). The precise reason is in the `scanner-error`
                // banner above; here we only refuse to assert a false scan verdict.
                <span data-testid="scanner-empty-degraded">
                  Scanner results couldn't be refreshed just now — see the message above. This is a temporary feed issue, not an empty market.
                </span>
              ) : scanExists ? (
                <span data-testid="scanner-scanned-empty">
                  Scan complete — no qualifying setups in {activeUniverse?.label ?? "this universe"} right now. Nothing met the scanner's criteria; try another universe above or scan again shortly.
                </span>
              ) : (
                <span data-testid="scanner-never-scanned">
                  No scan run yet for {activeUniverse?.label ?? "this universe"} — click "Scan" or "Start Auto Scan" above to analyze the market.
                </span>
              )
            }
          />
        </CardContent></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {opps.map((o, i) => (
            <Card
              key={`${o.symbol}-${o.timeframe}-${i}`}
              className={`border-l-4 ${oppEdgeClass(o.opportunity.label)}`}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">{o.symbol} <span className="text-xs text-muted-foreground">{o.timeframe}</span></CardTitle>
                  {/* Withheld (masked simulator) rows carry no score — "—", never a measured-looking 0. */}
                  <Badge className={LABEL_COLORS[o.opportunity.label] ?? ""}>{o.opportunity.label} {o.opportunity.score ?? "—"}</Badge>
                </div>
                <CardDescription className="flex flex-wrap items-center gap-1.5 mt-1">
                  <Badge variant={o.recommendedAction === "BUY" ? "default" : o.recommendedAction === "SELL" ? "destructive" : "outline"} className="text-xs">{o.recommendedAction}</Badge>
                  <Badge variant="outline" className="text-xs">{o.bias}</Badge>
                  <Badge
                    className={`text-xs ${BADGE_COLORS[o.statusBadge] ?? ""}`}
                    data-status-badge={o.statusBadge}
                  >
                    {BADGE_LABELS[o.statusBadge] ?? "Working on it"}
                  </Badge>
                  {(() => {
                    const c = cohesionMap.get(o.symbol);
                    if (!c) return null;
                    return (
                      <Badge
                        variant="outline"
                        className={`text-xs ${COHESION_SHELL[c.cohesionTone]}`}
                        data-testid={`scanner-aaci-${o.symbol}`}
                      >
                        Sync: {c.recommendedActionLabel}
                      </Badge>
                    );
                  })()}
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs space-y-2">
                {(() => {
                  const c = cohesionMap.get(o.symbol);
                  const mult = c?.confidenceMultiplier ?? 1;
                  // Canonical field first; deprecated alias as fallback for older payloads.
                  // null = withheld (server-masked simulator row): render "—" so a
                  // withheld read can never masquerade as a measured score of 0.
                  const strength = o.signalStrength ?? o.confidenceScore;
                  const adjusted = strength == null ? null : mult < 1 ? Math.round(strength * mult) : strength;
                  return (
                    <>
                      <div className="grid grid-cols-3 gap-1 text-center">
                        <div className="rounded-md bg-muted/40 p-1.5">
                          <div className="text-muted-foreground">Conf</div>
                          <div className="font-mono font-semibold tabular-nums" data-testid={`scanner-conf-${o.symbol}`}>
                            {adjusted ?? "—"}
                            {mult < 1 && strength != null && (
                              <span className="ml-1 text-[10px] font-normal text-muted-foreground line-through">{strength}</span>
                            )}
                          </div>
                        </div>
                        <div className="rounded-md bg-muted/40 p-1.5"><div className="text-muted-foreground">Risk</div><div className="font-mono font-semibold tabular-nums">{o.riskScore ?? "—"}</div></div>
                        <div className="rounded-md bg-muted/40 p-1.5"><div className="text-muted-foreground">Sniper</div><div className="font-mono font-semibold tabular-nums">{o.entrySniperScore ?? "—"}</div></div>
                      </div>
                      {mult < 1 && (
                        <div className="text-[10px] text-muted-foreground italic" data-testid={`scanner-conf-note-${o.symbol}`}>
                          Confidence adjusted for cohesion
                        </div>
                      )}
                    </>
                  );
                })()}
                <div className="text-xs flex items-center justify-between gap-2">
                  <span><span className="text-muted-foreground">Setup:</span> {o.setupType}</span>
                  <SetupQualityBadge symbol={o.symbol} side={o.recommendedAction === "SELL" ? "sell" : "buy"} />
                </div>
                <div className="text-xs text-muted-foreground italic">"{o.reasonForTrade}"</div>
                {o.reasonToAvoid && <div className="text-xs text-danger">⚠ {o.reasonToAvoid}</div>}
                <RubySetupReason
                  signal={{
                    symbol: o.symbol, timeframe: o.timeframe,
                    recommendedAction: o.recommendedAction, bias: o.bias,
                    // Withheld (null) values stay absent — never coerced to 0.
                    signalStrength: (o.signalStrength ?? o.confidenceScore) ?? undefined,
                    confidenceScore: o.confidenceScore ?? undefined, riskScore: o.riskScore ?? undefined,
                    entrySniperScore: o.entrySniperScore ?? undefined, reasonForTrade: o.reasonForTrade,
                    reasonToAvoid: o.reasonToAvoid, setupType: o.setupType,
                    entry: o.entry ?? undefined, stopLoss: o.stopLoss ?? undefined, takeProfit: o.takeProfit ?? undefined,
                    statusBadge: o.statusBadge,
                  }}
                  dense
                />
                {o.timingContext && (
                  <ScannerTimingBadges ctx={o.timingContext} isGold={isGoldMode(o.symbol)} />
                )}
                <div className="grid grid-cols-3 gap-1 pt-2 border-t">
                  {/* A withheld (masked simulator) row has no entry/SL/TP — the
                      trade ticket must never be seeded from it, so the trade
                      actions are honestly disabled with the reason. */}
                  <Button
                    size="sm"
                    className="h-9 border border-success/30 bg-success/15 text-sm font-bold text-success"
                    disabled={o.withheld === true}
                    title={o.withheld ? "Waiting for verified feed — trade setup withheld" : undefined}
                    onClick={() => {
                      if (o.withheld) return;
                      // PART B — Scanner.openTradeModal timing.
                      // Target: modal visible <250ms. The end mark fires
                      // from ScannerTradeModal once its shell renders.
                      const tid = markActionStart("scanner.openTradeModal", { page: "market-scanner" });
                      setTradeTarget({ opp: o, side: "BUY" });
                      markUiFeedback(tid);
                      // End is captured in the same microtask so we
                      // measure the synchronous click→state-set cost.
                      // Modal mount cost is measured separately.
                      markActionEnd(tid);
                    }}
                    data-testid={`scanner-buy-${o.symbol}`}
                  >BUY</Button>
                  <Button
                    size="sm"
                    className="h-9 border border-danger/30 bg-danger/15 text-sm font-bold text-danger"
                    disabled={o.withheld === true}
                    title={o.withheld ? "Waiting for verified feed — trade setup withheld" : undefined}
                    onClick={() => {
                      if (o.withheld) return;
                      const tid = markActionStart("scanner.openTradeModal", { page: "market-scanner" });
                      setTradeTarget({ opp: o, side: "SELL" });
                      markUiFeedback(tid);
                      markActionEnd(tid);
                    }}
                    data-testid={`scanner-sell-${o.symbol}`}
                  >SELL</Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 text-xs"
                    disabled={o.withheld === true}
                    title={o.withheld ? "Waiting for verified feed — trade setup withheld" : undefined}
                    onClick={() => { if (!o.withheld) setTradeTarget({ opp: o, side: o.recommendedAction === "SELL" ? "SELL" : "BUY" }); }}
                  >
                    <Sliders className="h-3 w-3 mr-1" />Trade Setup
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1 pt-1">
                  {realIsAdmin && (
                    <>
                      <Link href={`/trade-grader?symbol=${o.symbol}`}><Button size="sm" variant="ghost" className="h-6 px-2 text-xs">Grade</Button></Link>
                      <Link href={`/market-replay?symbol=${o.symbol}`}><Button size="sm" variant="ghost" className="h-6 px-2 text-xs">Replay</Button></Link>
                      <Link href="/testing-lab"><Button size="sm" variant="ghost" className="h-6 px-2 text-xs">Backtest</Button></Link>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs ml-auto"
                        title={`Files a tester-capture row for operator review at the fixed tester caps (${TESTER_INTENT_LOT} lots, $${TESTER_INTENT_MAX_LOSS_USD} max loss). No order is placed.`}
                        onClick={() => void captureForOperatorReview(o)}
                        data-testid={`scanner-capture-review-${o.symbol}`}
                      >
                        <Send className="h-3 w-3 mr-1" />Capture for operator review
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );

  const symbolsTab = (
    <div className="space-y-3" data-testid="symbols-tab-content">
      <p className="text-xs text-muted-foreground">
        Search any market — forex pairs, metals, indices, crypto, stocks,
        or Deriv synthetics (V10..V100, BOOM/CRASH/STEP). Pick one to
        update Focus, the chart, and the trade ticket everywhere.
      </p>
      <SymbolExplorer
        activeSymbol={symbolsTabActive}
        onSelect={(canonical) => setChartSymbol(canonical)}
      />
    </div>
  );

  const broadScanTab = (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
              <Radar className="h-[18px] w-[18px]" />
            </span>
            Broad Scan
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-txt-muted">Scan Universe</span>
            <Select value={universe} onValueChange={(v) => void changeUniverse(v as UniverseId)}>
              <SelectTrigger className="w-full sm:w-[200px] h-9 min-w-0" data-testid="scanner-universe-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {universes.length === 0
                  ? <SelectItem value="all">All Markets</SelectItem>
                  : universes.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.label}{!u.available ? " · feed required" : ` · ${u.symbols.length}`}
                      </SelectItem>
                    ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Button
              size="sm"
              variant="outline"
              onClick={scan}
              disabled={busy || !universeAvailable || scanCoolingDown}
              data-testid="scanner-btn-scan"
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              {scanCoolingDown ? `Scan again in ${cooldownSecs}s` : "Scan"}
            </Button>
            {realIsAdmin ? (
              status?.running
                ? <Button size="sm" variant="outline" onClick={stop} disabled={busy} data-testid="scanner-btn-stop"><Square className="h-4 w-4 mr-1" />Stop</Button>
                : <Button size="sm" onClick={start} disabled={busy || !universeAvailable} data-testid="scanner-btn-start"><Play className="h-4 w-4 mr-1" />Start Auto Scan</Button>
            ) : (
              // Start/Stop drive the operator-controlled engine (admin-gated on
              // the server). For non-admins we render a disabled control with an
              // honest reason rather than letting it silently 403.
              <span className="flex items-center gap-2" title="Scanner engine is operator-controlled — results refresh automatically">
                <Button size="sm" variant="outline" disabled data-testid="scanner-btn-start-disabled"><Play className="h-4 w-4 mr-1" />Start Auto Scan</Button>
                <span className="text-xs text-muted-foreground hidden sm:inline">Operator-controlled — results refresh automatically</span>
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ONE scalp scan panel (merge-map item D): the old Broad ranking and
          the separate Scalp Builder tab are folded into RubyScalpScan — rank
          the universe by default, or open the optional goal to find the single
          best fit. Same shared engine + live-quote path either way. */}
      <RubyScalpScan onPick={handleScalpPick} onBuild={openScalpTrade} />

      {/* Opportunity map + the engine feed results, stacked as one results
          column: the map is the categorized read of the SAME scan the legacy
          results block lists card-by-card below it. */}
      <div className="space-y-3" data-testid="broad-scan-results">
        <BroadScanOpportunityMap
          marketGroup={opportunityMapGroup(universe)}
          selectedSymbol={symbolsTabActive}
          onPick={handleSymbolPick}
          onScanned={setMapScanned}
        />

        {resultsBlock}
      </div>

      {activeUniverse && activeUniverse.symbols.length > 0 && (
        <CollapsibleSection
          title={`Scan universe symbols (${activeUniverse.symbols.length})`}
          description={`${activeUniverse.label} — the symbols the scanner is scoring right now.`}
          storageKey="scanner.universeSymbols"
          testId="scanner-universe-symbols"
        >
          <div className="flex flex-wrap gap-1 text-xs">
            {activeUniverse.symbols.map((s) => (
              <Badge key={s} variant="outline" className="font-mono">{s}</Badge>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {status?.feedNote && (
        <CompactAlert
          tone="info"
          title="Feed status"
          description={status.feedNote}
          testId="scanner-feed-note"
        />
      )}

      {notice && (
        <CompactAlert
          tone={notice.tone}
          title={notice.title}
          description={notice.description}
          testId="scanner-capture-notice"
        />
      )}

      {/* The description belongs to the panel, not to this page: CollapsibleSection
          renders it unconditionally right above <RecentScannerTrades/>, so an
          inline string here can (and did) contradict the panel one line below it.
          Import the constant — never re-type the sentence. */}
      <CollapsibleSection
        title="Recent scanner trades"
        description={RECENT_SCANNER_TRADES_SECTION_DESCRIPTION}
        storageKey="scanner.recentTrades"
        testId="scanner-recent-trades"
        defaultOpen
      >
        <RecentScannerTrades />
      </CollapsibleSection>
    </div>
  );

  return (
    // The Ruby Chart Read store is page-scoped (Task #600): the header strip's
    // Ruby cell, the chart panel's read, and any scalp-card reads all share ONE
    // server read keyed by symbol+timeframe so they can never disagree.
    <RubyReadStoreProvider>
    <SelectedActionStoreProvider>
    {/* Keep the last result card clear of the fixed mobile bottom nav (h-14) and
        the floating Ruby orb (bottom-20 right-4 on mobile); add the device
        safe-area inset so content is not hidden behind a home indicator. */}
    <div className="mx-auto w-full max-w-[1200px] space-y-4 pt-1 sm:pt-2 pb-[calc(8rem+env(safe-area-inset-bottom))] md:pb-6">
      <ScannerHeaderSummary running={Boolean(status?.running)} busy={busy} />

      {err && (
        <CompactAlert
          tone="danger"
          title="Scanner error"
          description={err}
          testId="scanner-error"
          rightSlot={
            <Button
              size="sm"
              variant="outline"
              onClick={retryNow}
              disabled={retrying}
              data-testid="scanner-error-retry"
              className="h-6 shrink-0 px-2 text-xs"
            >
              <RefreshCw className={`h-3 w-3 mr-1${retrying ? " animate-spin" : ""}`} />
              {retrying ? "Retrying…" : "Retry now"}
            </Button>
          }
        />
      )}

      <SectionErrorBoundary section="Chart">
        <ScannerChartPanel />
      </SectionErrorBoundary>

      <SectionErrorBoundary section="Trade Health">
        <TradeHealthPanel chartSymbol={chartSym} />
      </SectionErrorBoundary>

      <PageTabs
        storageKey="market-scanner"
        defaultTab="focus"
        variant="pill"
        tabs={[
          { id: "focus",      label: "Focus",      icon: <Target className="h-3.5 w-3.5" />, content: <SectionErrorBoundary section="Focus">{focusTab}</SectionErrorBoundary> },
          // The former "Scalp Builder" tab is folded into Broad Scan as the
          // optional goal picker on RubyScalpScan. PageTabs validates the
          // persisted tab id, so a stored "scalp-builder" falls back to Focus.
          { id: "broad-scan", label: "Broad Scan", icon: <Radar className="h-3.5 w-3.5" />,  content: <SectionErrorBoundary section="Broad Scan">{broadScanTab}</SectionErrorBoundary> },
          { id: "symbols",    label: "Symbols",    icon: <Layers className="h-3.5 w-3.5" />, content: <SectionErrorBoundary section="Symbols">{symbolsTab}</SectionErrorBoundary> },
        ]}
      />

      {tradeTarget && (
        <SectionErrorBoundary section="Trade ticket">
        <ScannerTradeModal
          open={!!tradeTarget}
          onClose={() => setTradeTarget(null)}
          signal={{
            symbol: tradeTarget.opp.symbol, timeframe: tradeTarget.opp.timeframe,
            recommendedAction: tradeTarget.opp.recommendedAction, bias: tradeTarget.opp.bias,
            // Withheld (null) values seed as absent — the ticket shows empty
            // price fields, never a fabricated entry/SL/TP of 0. (The trade
            // buttons on a withheld row are disabled; this is defense in depth.)
            signalStrength: (tradeTarget.opp.signalStrength ?? tradeTarget.opp.confidenceScore) ?? undefined,
            confidenceScore: tradeTarget.opp.confidenceScore ?? undefined, riskScore: tradeTarget.opp.riskScore ?? undefined,
            entrySniperScore: tradeTarget.opp.entrySniperScore ?? undefined,
            reasonForTrade: tradeTarget.opp.reasonForTrade, reasonToAvoid: tradeTarget.opp.reasonToAvoid,
            setupType: tradeTarget.opp.setupType,
            entry: tradeTarget.opp.entry ?? undefined, stopLoss: tradeTarget.opp.stopLoss ?? undefined, takeProfit: tradeTarget.opp.takeProfit ?? undefined,
            statusBadge: tradeTarget.opp.statusBadge,
          }}
          defaultSide={tradeTarget.side}
        />
        </SectionErrorBoundary>
      )}

      {scalpTrade && (
        <SectionErrorBoundary section="Scalp trade ticket">
        <ScannerTradeModal
          open={!!scalpTrade}
          onClose={() => setScalpTrade(null)}
          signal={scalpResultToSignal(scalpTrade.result)}
          defaultSide={scalpTrade.side}
        />
        </SectionErrorBoundary>
      )}
    </div>
    </SelectedActionStoreProvider>
    </RubyReadStoreProvider>
  );
}
