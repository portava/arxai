// Open Trades — the live position cockpit. Full redesign to the ARX dashboard
// direction. UI/UX + live-position management pass ONLY.
//
// Wiring preserved exactly: positions come from GET /api/me/trades/open
// (credentials-included, polled every 5s) using the same OpenCard shape as
// MyOpenTradesPanel. Closing a position uses the existing, permissioned
// ConfirmCloseModal — the ONLY close path; the UI never calls MT5 directly and
// no new execution path is created. Only MT5-confirmed open positions are
// shown. Every metric is derived from the real cards. Bulk execution actions
// (Protect All, Move-all-to-BE, Close Winners/Losers/All) have no per-user
// endpoints and are intentionally absent — no placebo controls. Export is a
// real client-side CSV of the currently filtered rows (no backend involved,
// no server round-trip, nothing fabricated: cells mirror the visible table).

import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity, Sparkles, MessageCircle, ShieldCheck, ShieldAlert,
  TrendingUp, TrendingDown, Search, RefreshCcw, Globe, Clock, Zap,
  ChevronRight, AlertTriangle, Loader2, X as XIcon, BellRing, Plus, Flame,
  Download,
} from "lucide-react";
import {
  useGetTimingBrainMulti,
  getGetTimingBrainMultiQueryKey,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { ConfirmCloseModal } from "@/components/trading/ConfirmCloseModal";
import { QuickTradeModal } from "@/components/trading/QuickTradeModal";
import { useChartSymbol } from "@/lib/use-chart-symbol";
import { useAssistantName } from "@/lib/assistant-name";
import { useLiveAccountSnapshot } from "@/hooks/useLiveAccountSnapshot";
import { CanonicalBalancePanel } from "@/components/account/CanonicalBalancePanel";
import { FreshnessBadge } from "@/components/ui/FreshnessBadge";

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

const RUBY_OPEN_KEY = "arx.assistant.open.v2";
function openRubyLiveChat() {
  try {
    sessionStorage.setItem(RUBY_OPEN_KEY, "1");
    window.dispatchEvent(new StorageEvent("storage", { key: RUBY_OPEN_KEY }));
  } catch { /* silent */ }
}

// Same shape MyOpenTradesPanel uses (MT5-confirmed open positions only).
type OpenCard = {
  id: string;
  source: "user_owned_mt5" | "shared_master_attribution";
  routingMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
  accountType: "demo" | "live" | "unknown";
  symbol: string;
  side: "BUY" | "SELL";
  lotSize: number;
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  unrealizedPnl: number | null;
  pnlIsEstimate: boolean;
  pnlPercent: number | null;
  status: string;
  openedAt: string | null;
  brokerLabelMasked: string | null;
  waitingForSync: boolean;
  pnlObservedAt?: string | null;
};
type OpenResponse = {
  ok: boolean;
  routingMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
  accountType: "demo" | "live" | "unknown";
  tradingMode: "DISABLED" | "DEMO" | "LIVE" | "SIMULATED";
  bannerLabel: string;
  cards: OpenCard[];
};

type PosFilter = "all" | "winning" | "losing" | "unprotected" | "protected";

function money(n: number | null | undefined): string {
  const v = n ?? 0;
  return `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
}
function plain(n: number | null | undefined): string {
  return n == null ? "—" : `$${n.toFixed(2)}`;
}
const pnlTone = (n: number | null) => (n == null ? "text-txt-muted" : n > 0 ? "text-success" : n < 0 ? "text-danger" : "text-txt-secondary");
// A card's P/L is known only once the broker has reported it; a waiting card
// is unknown, never $0.00.
const pnlKnown = (c: OpenCard): c is OpenCard & { unrealizedPnl: number } => !c.waitingForSync && c.unrealizedPnl != null;
const UNREPORTED = "Not reported";
const isProtected = (c: OpenCard) => c.stopLoss != null;
function durationLabel(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// RFC 4180 escaping: quote any cell containing a comma, quote, or newline.
function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function MyTradesPage() {
  const [, navigate] = useLocation();
  const [, setChartSymbol] = useChartSymbol();
  const { name } = useAssistantName();
  const [data, setData] = useState<OpenResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // When the cards on screen were last loaded successfully. After a failed
  // refresh the cards are a cached copy and the summary says so.
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [closing, setClosing] = useState<OpenCard | null>(null);
  const [openModal, setOpenModal] = useState(false);
  const [filter, setFilter] = useState<PosFilter>("all");
  const [query, setQuery] = useState("");

  // Shared SSE snapshot — same source as Dashboard so open P/L and count match.
  // Used only for the freshness badge in the status strip; per-card P/L still
  // comes from the routing-aware /api/me/trades/open endpoint.
  const liveSnap = useLiveAccountSnapshot();

  async function load() {
    try {
      const r = await fetch(u("/api/me/trades/open"), { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as OpenResponse);
      setLoadedAt(Date.now());
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const cards = useMemo(() => data?.cards ?? [], [data]);

  // Phase 3 — advisory timing reads for all open symbols (fail-open).
  const uniqueSymbols = useMemo(() => [...new Set(cards.map((c) => c.symbol))], [cards]);
  const timingQ = useGetTimingBrainMulti(
    { symbols: uniqueSymbols.join(",") },
    {
      query: {
        queryKey: getGetTimingBrainMultiQueryKey({ symbols: uniqueSymbols.join(",") }),
        enabled: uniqueSymbols.length > 0,
        refetchInterval: 90_000,
        retry: false,
        staleTime: 60_000,
      },
    },
  );
  const timingMap = useMemo(() => {
    const results = (timingQ.data as { results?: Array<{ symbol?: string; timingGrade?: string; entryPermission?: string; heatScore?: number; dangerScore?: number }> } | undefined)?.results ?? [];
    const m = new Map<string, { timingGrade: string; entryPermission: string; heatScore: number; dangerScore: number }>();
    for (const r of results) {
      if (r.symbol) {
        m.set(r.symbol, {
          timingGrade: r.timingGrade ?? "?",
          entryPermission: r.entryPermission ?? "?",
          heatScore: r.heatScore ?? 0,
          dangerScore: r.dangerScore ?? 0,
        });
      }
    }
    return m;
  }, [timingQ.data]);

  // ── Derived summary (real data only) ──────────────────────────────────────
  const sum = useMemo(() => {
    // The total is stated only when every position's P/L has been reported;
    // otherwise it is unknown (a partial sum would read as the whole book).
    const known = cards.filter(pnlKnown);
    const unreportedN = cards.length - known.length;
    const openPnl: number | null = unreportedN === 0 ? known.reduce((s, c) => s + c.unrealizedPnl, 0) : null;
    const totalLots = cards.reduce((s, c) => s + (c.lotSize ?? 0), 0);
    const protectedN = cards.filter(isProtected).length;
    const unprotectedN = cards.length - protectedN;
    const withWinner = known.reduce<(OpenCard & { unrealizedPnl: number }) | null>((b, c) => (!b || c.unrealizedPnl > b.unrealizedPnl ? c : b), null);
    const withLoser = known.reduce<(OpenCard & { unrealizedPnl: number }) | null>((b, c) => (!b || c.unrealizedPnl < b.unrealizedPnl ? c : b), null);
    const longLots = cards.filter((c) => c.side === "BUY").reduce((s, c) => s + c.lotSize, 0);
    const shortLots = cards.filter((c) => c.side === "SELL").reduce((s, c) => s + c.lotSize, 0);
    const noSL = cards.filter((c) => c.stopLoss == null).length;
    const noTP = cards.filter((c) => c.takeProfit == null).length;
    // Shared-master rows carry an allocation estimate, not a broker figure; a
    // total that includes one is an estimate too.
    const estimateN = known.filter((c) => c.pnlIsEstimate).length;
    return { openPnl, unreportedN, estimateN, totalLots, protectedN, unprotectedN, withWinner, withLoser, longLots, shortLots, noSL, noTP };
  }, [cards]);

  const visible = useMemo(() => {
    let list = cards;
    if (filter === "winning") list = list.filter((c) => pnlKnown(c) && c.unrealizedPnl > 0);
    else if (filter === "losing") list = list.filter((c) => pnlKnown(c) && c.unrealizedPnl < 0);
    else if (filter === "protected") list = list.filter(isProtected);
    else if (filter === "unprotected") list = list.filter((c) => !isProtected(c));
    if (query) list = list.filter((c) => c.symbol.toLowerCase().includes(query.toLowerCase()));
    return list;
  }, [cards, filter, query]);

  const liveLabel = data?.bannerLabel
    || (data?.tradingMode === "LIVE" ? "Live Shared MT5" : data?.tradingMode === "DEMO" ? "Demo" : data?.tradingMode ?? "Checking");

  // Client-side CSV export of the CURRENTLY FILTERED rows. Columns mirror the
  // visible table exactly; no backend endpoint exists for a user-scoped trade
  // export, so nothing is fetched — only data already on screen is written.
  // Open P/L is left blank while a row is still syncing (the table shows
  // "syncing…" there, so a number would be fabricated).
  function exportCsv() {
    const header = ["Symbol", "Side", "Lots", "Entry", "Current", "Open P/L", "P/L Is Estimate", "SL", "TP", "Duration", "Protection", "Heat Grade"];
    const rows = visible.map((c) => [
      c.symbol,
      c.side,
      c.lotSize,
      c.entryPrice,
      c.currentPrice,
      c.waitingForSync ? "" : c.unrealizedPnl ?? "",
      c.waitingForSync ? "" : c.pnlIsEstimate ? "yes" : "no",
      c.stopLoss,
      c.takeProfit,
      durationLabel(c.openedAt),
      isProtected(c) ? "Protected" : "Unprotected",
      timingMap.get(c.symbol)?.timingGrade ?? "",
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `open-trades-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Strip P/L: the shared SSE snapshot when it is live, else the cards' total
  // (null while any position's P/L is not reported — never a $0.00 stand-in).
  const stripFromSnapshot = !liveSnap.isUnavailable && liveSnap.snapshot?.openPL != null;
  const stripPnl: number | null = stripFromSnapshot
    ? liveSnap.snapshot!.openPL
    : data == null ? null : sum.openPnl;
  const stripIsEstimate = stripFromSnapshot ? liveSnap.isEstimate === true : sum.estimateN > 0;
  // When the strip shows the account snapshot's total while some positions
  // have no P/L yet, both figures are named by source so the page never gives
  // two unexplained answers for the same book.
  const snapshotOpenPl: number | null = stripFromSnapshot ? liveSnap.snapshot!.openPL : null;
  const snapshotNote = snapshotOpenPl != null && sum.openPnl == null && cards.length > 0
    ? `The account snapshot reports ${money(snapshotOpenPl)}${stripIsEstimate ? " est." : ""} in total.`
    : null;

  // Summary badge: "Healthy" only for a book that loaded on the latest poll.
  const summaryBadge: { label: string; tone: string } = data == null
    ? (err ? { label: "Unavailable", tone: "border-danger/40 bg-danger/10 text-danger" } : { label: "Checking", tone: "border-border bg-secondary/40 text-txt-muted" })
    : err ? { label: "Not current", tone: "border-warning/40 bg-warning/10 text-warning" }
    : cards.length === 0 ? { label: "No positions", tone: "border-border bg-secondary/40 text-txt-muted" }
    : sum.unprotectedN > 0 ? { label: "Needs Protection", tone: "border-warning/40 bg-warning/10 text-warning" }
    : { label: "Healthy", tone: "border-success/40 bg-success/10 text-success" };
  const loadedAtLabel = loadedAt == null ? null : new Date(loadedAt).toLocaleTimeString();
  const notLoadedCopy = `Open positions could not be loaded (${err ?? "unknown error"}).`;
  const stripState: "error" | "loading" | "waiting" | "ok" = err
    ? "error"
    : data == null
    ? "loading"
    : sum.unreportedN > 0
    ? "waiting"
    : "ok";

  // By-symbol exposure (real lots).
  const bySymbol = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards) m.set(c.symbol, (m.get(c.symbol) ?? 0) + c.lotSize);
    const total = sum.totalLots || 1;
    return Array.from(m.entries()).map(([symbol, lots]) => ({ symbol, lots, pct: Math.round((lots / total) * 100) }));
  }, [cards, sum.totalLots]);

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 p-4 md:p-6 pb-32 md:pb-6">
      {/* Hero */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
            <Activity className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Open Trades</h1>
            <p className="text-sm text-txt-secondary">Monitor live positions, protection, exposure, and {name}’s trade management guidance.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={openRubyLiveChat} className="inline-flex items-center gap-2 rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-2 text-sm font-medium text-ruby hover:bg-ruby/15">
            <MessageCircle className="h-4 w-4" /> Ask {name}
          </button>
          <button onClick={() => setOpenModal(true)} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90">
            <Plus className="h-4 w-4" /> Open Trade
          </button>
        </div>
      </div>

      {/* Live status strip
          Count and open P/L prefer the shared SSE snapshot so they always
          match the Dashboard Account Snapshot card exactly (same adapter,
          same source). Per-card P/L below still comes from /me/trades/open
          which has the richer per-position detail needed for sorting/filtering. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-card px-4 py-2 text-sm">
        {/* Green only when positions loaded and every one has reported P/L. */}
        <span className="inline-flex items-center gap-1.5"><span data-testid="open-trades-status-dot" data-state={stripState} className={cn("h-2 w-2 rounded-full", stripState === "error" ? "bg-danger" : stripState === "ok" ? "bg-success" : stripState === "waiting" ? "bg-warning" : "bg-txt-muted")} /><span className="text-txt-secondary">{liveLabel}</span></span>
        <span className="text-txt-muted">
          {(!liveSnap.isUnavailable && liveSnap.snapshot != null
            ? liveSnap.snapshot.openPositionsCount
            : cards.length)} Open Trade{(
              (!liveSnap.isUnavailable && liveSnap.snapshot != null
                ? liveSnap.snapshot.openPositionsCount
                : cards.length) === 1 ? "" : "s")}
        </span>
        <span className="text-txt-muted">Open P/L <span data-testid="open-trades-strip-pnl" className={cn("font-medium", pnlTone(stripPnl))}>{stripPnl == null ? (cards.length === 0 ? "—" : `${UNREPORTED} (${sum.unreportedN} of ${cards.length} positions)`) : <>{money(stripPnl)}{stripIsEstimate && <span className="ml-1 text-[10px] text-txt-muted">est.</span>}</>}</span>{stripFromSnapshot && <span data-testid="open-trades-strip-pnl-source" className="ml-1 text-[10px] text-txt-muted">account snapshot</span>}</span>
        <span className="text-txt-muted">Total Lots <span className="text-foreground font-medium">{sum.totalLots.toFixed(2)}</span></span>
        <span className="text-txt-muted">Exposure <span className="text-success font-medium">{cards.length === 0 ? "None" : "Active"}</span></span>
        {liveSnap.snapshot != null && (
          <FreshnessBadge
            freshness={liveSnap.freshness}
            lastUpdatedMs={liveSnap.lastUpdatedMs}
            isEstimate={liveSnap.isEstimate}
          />
        )}
      </div>

      {/* Canonical balance (Task #430) — same source of truth as the Dashboard,
          account, risk panel, wallet and admin. */}
      <CanonicalBalancePanel live={liveSnap.live} title="Live balance" />

      {/* Bridge / error state */}
      {err && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
          {/* The failure is the /me/trades/open request; its cause is not
              known here, so the banner names the request, as the summary does. */}
          <span data-testid="open-trades-error-banner" className="inline-flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> {data == null ? notLoadedCopy : `Open positions could not be refreshed (${err}).`} Retrying every 5 seconds.</span>
        </div>
      )}

      {/* Top row: Summary + Ruby read + Protection */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Live Position Summary */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2"><Activity className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">Live Position Summary</h3></div>
            <span data-testid="position-summary-badge" className={cn("rounded-md border px-2 py-0.5 text-xs", summaryBadge.tone)}>
              {summaryBadge.label}
            </span>
          </div>
          {err && data != null && (
            <p data-testid="position-summary-stale" className="mt-2 text-xs text-warning">
              Refresh failed ({err}). Showing positions as last loaded at {loadedAtLabel ?? "an unknown time"}; the book may have changed since.
            </p>
          )}
          {cards.length === 0 ? (
            <p className="mt-3 text-sm text-txt-muted">{data == null ? (err ? notLoadedCopy : "Checking open positions…") : "No open trades right now."}</p>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Mini label="Open Trades" value={String(cards.length)} />
              <Mini testId="position-summary-open-pnl" label="Open P/L" value={sum.openPnl == null ? UNREPORTED : `${money(sum.openPnl)}${sum.estimateN > 0 ? " est." : ""}`} tone={pnlTone(sum.openPnl)} sub={sum.openPnl == null ? `${sum.unreportedN} of ${cards.length} awaiting broker P/L${snapshotNote ? `. ${snapshotNote}` : ""}` : sum.estimateN > 0 ? `${sum.estimateN} of ${cards.length} estimated (shared-account allocation)` : undefined} />
              <Mini label="Total Lots" value={sum.totalLots.toFixed(2)} />
              <Mini label="Protected" value={`${sum.protectedN} / ${cards.length}`} />
              <Mini label="Unprotected" value={String(sum.unprotectedN)} tone={sum.unprotectedN ? "text-danger" : undefined} />
              <Mini label="Biggest Winner" value={sum.withWinner ? money(sum.withWinner.unrealizedPnl) : "—"} tone="text-success" sub={sum.withWinner?.symbol} />
              <Mini label="Biggest Loser" value={sum.withLoser ? money(sum.withLoser.unrealizedPnl) : "—"} tone="text-danger" sub={sum.withLoser?.symbol} />
            </div>
          )}
        </div>

        {/* Ruby's Live Trade Read */}
        <div className="rounded-2xl border border-ruby/25 bg-card p-4">
          <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-ruby" /><h3 className="text-sm font-semibold text-ruby">{name}’s Live Trade Read</h3></div>
          {cards.length === 0 ? (
            <p className="mt-2 text-sm text-txt-muted">{name} will give live trade guidance once open positions are available.</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-txt-secondary">
                {sum.openPnl == null
                  ? `Open P/L is not reported yet for ${sum.unreportedN} of ${cards.length} position${cards.length === 1 ? "" : "s"}.${snapshotNote ? ` ${snapshotNote}` : ""}`
                  : sum.openPnl > 0 ? "Your open trades are net positive right now."
                  : sum.openPnl < 0 ? "Your open trades are net negative right now."
                  : "Your open trades are flat right now."}{" "}
                {sum.unprotectedN > 0 ? `${sum.unprotectedN} position${sum.unprotectedN === 1 ? " is" : "s are"} unprotected — consider adding a stop.` : "All positions have a stop in place."}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Tag label={`Exposure: ${cards.length ? "Active" : "Low"}`} tone="border-primary/40 text-primary" />
                <Tag label={`Protection: ${sum.protectedN}/${cards.length}`} tone="border-success/40 text-success" />
              </div>
            </>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={openRubyLiveChat} className="inline-flex items-center gap-1.5 rounded-lg border border-ruby/40 bg-ruby/10 px-2.5 py-1.5 text-xs text-ruby"><MessageCircle className="h-3.5 w-3.5" /> Ask {name}</button>
            <button onClick={() => navigate("/risk-settings")} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground hover:border-primary/40"><ShieldAlert className="h-3.5 w-3.5" /> Review Risk</button>
          </div>
        </div>

        {/* Protection & Risk */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">Protection &amp; Risk</h3></div>
          {cards.length === 0 ? (
            <p className="mt-3 text-sm text-txt-muted">Protection status will appear once open positions are loaded.</p>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Stat dot="bg-success" label="Protected" value={sum.protectedN} />
              <Stat dot="bg-danger" label="Near Stop Loss" value="—" />
              <Stat dot="bg-danger" label="Unprotected" value={sum.unprotectedN} />
              <Stat dot="bg-warning" label="Near Take Profit" value="—" />
              <Stat dot="bg-danger" label="Without SL" value={sum.noSL} />
              <Stat dot="bg-warning" label="Without TP" value={sum.noTP} />
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button onClick={() => setFilter("unprotected")} className="rounded-lg border border-border px-3 py-2 text-xs text-foreground hover:border-primary/40">Review Unprotected</button>
            <button onClick={() => navigate("/risk-settings")} className="rounded-lg border border-border px-3 py-2 text-xs text-foreground hover:border-primary/40">Risk Settings</button>
          </div>
        </div>
      </div>

      {/* Live Positions */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-2 pr-1 text-sm font-semibold"><Activity className="h-4 w-4 text-primary" /> Live Positions</span>
            {([["all","All"],["winning","Winning"],["losing","Losing"],["unprotected","Unprotected"],["protected","Protected"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k)}
                className={cn("rounded-lg border px-2.5 py-1 text-xs", filter === k ? "border-primary bg-primary text-white" : "border-border bg-card text-txt-secondary hover:text-foreground")}>
                {label}
              </button>
            ))}
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <div className="relative w-full sm:w-52">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-muted" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search positions…" className="w-full rounded-lg border border-border bg-background/40 pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
            </div>
            <button
              onClick={exportCsv}
              disabled={visible.length === 0}
              title={visible.length === 0 ? "No rows in the current filter to export" : "Download the currently filtered rows as CSV"}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-2 text-xs text-foreground hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" /> Export CSV
            </button>
          </div>
        </div>

        <div className="mt-3 overflow-x-auto">
          {loading ? (
            <p className="py-8 text-center text-sm text-txt-muted"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading open trades…</p>
          ) : data == null && err ? (
            <p className="py-8 text-center text-sm text-danger">{notLoadedCopy}</p>
          ) : visible.length === 0 ? (
            <EmptyPositions onTrade={() => setOpenModal(true)} onScanner={() => navigate("/market-scanner")} />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-txt-muted">
                  <th className="py-2 pr-3 font-medium">Symbol</th><th className="py-2 pr-3 font-medium">Side</th>
                  <th className="py-2 pr-3 font-medium">Lots</th><th className="py-2 pr-3 font-medium">Entry</th>
                  <th className="py-2 pr-3 font-medium">Current</th><th className="py-2 pr-3 font-medium text-right">Open P/L</th>
                  <th className="py-2 pr-3 font-medium">SL</th><th className="py-2 pr-3 font-medium">TP</th>
                  <th className="py-2 pr-3 font-medium">Duration</th><th className="py-2 pr-3 font-medium">Protection</th>
                  <th className="py-2 pr-3 font-medium" title="Advisory timing grade — never a gate">Heat</th>
                  <th className="py-2 pr-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const t = timingMap.get(c.symbol);
                  const isStandDown = t?.entryPermission === "STAND_DOWN";
                  const isHighDanger = (t?.dangerScore ?? 0) >= 70;
                  const showHeatWarn = t != null && (isStandDown || isHighDanger);
                  return (
                    <React.Fragment key={c.id}>
                      <tr className="border-b border-border/50 hover:bg-background/30">
                        <td className="py-2.5 pr-3 font-mono font-semibold">{c.symbol}</td>
                        <td className="py-2.5 pr-3">
                          <span className={cn("inline-flex items-center gap-1 font-mono text-xs", c.side === "BUY" ? "text-success" : "text-danger")}>
                            {c.side === "BUY" ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}{c.side}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-txt-secondary">{c.lotSize}</td>
                        <td className="py-2.5 pr-3 font-mono text-txt-secondary">{c.entryPrice ?? "—"}</td>
                        <td className="py-2.5 pr-3 font-mono text-txt-secondary">{c.currentPrice ?? "—"}</td>
                        <td className={cn("py-2.5 pr-3 text-right font-mono", pnlTone(c.unrealizedPnl))}>
                          {c.waitingForSync ? <span className="text-warning text-xs">syncing…</span> : pnlKnown(c) ? money(c.unrealizedPnl) : <span className="text-xs text-txt-muted">{UNREPORTED}</span>}
                          {c.pnlIsEstimate && pnlKnown(c) && <span className="ml-1 text-[10px] text-txt-muted">est.</span>}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-txt-secondary">{c.stopLoss ?? "—"}</td>
                        <td className="py-2.5 pr-3 font-mono text-txt-secondary">{c.takeProfit ?? "—"}</td>
                        <td className="py-2.5 pr-3 text-txt-muted">{durationLabel(c.openedAt)}</td>
                        <td className="py-2.5 pr-3">
                          <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-semibold", isProtected(c) ? "border-success/40 bg-success/10 text-success" : "border-danger/40 bg-danger/10 text-danger")}>
                            {isProtected(c) ? "Protected" : "Unprotected"}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3">
                          {/* Phase 3 — advisory timing grade badge; absent when unavailable */}
                          {!t ? (
                            <span className="text-[10px] text-txt-muted">—</span>
                          ) : (
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold",
                                new Set(["A+", "A", "B"]).has(t.timingGrade)
                                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                                  : t.dangerScore >= 65
                                    ? "border-rose-500/40 bg-rose-500/10 text-rose-400"
                                    : "border-amber-500/40 bg-amber-500/10 text-amber-400",
                              )}
                              title={`Timing: ${t.timingGrade} grade · H:${t.heatScore} D:${t.dangerScore} — advisory only`}
                            >
                              <Flame className="h-2.5 w-2.5" />
                              {t.timingGrade}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center justify-end gap-1.5">
                            <Link href={`/my-trades/${encodeURIComponent(c.id)}`}>
                              <button className="rounded-lg border border-border px-2 py-1 text-xs text-foreground hover:border-primary/40">Manage</button>
                            </Link>
                            <button onClick={() => { setChartSymbol(c.symbol); }} title="Open chart" className="grid h-7 w-7 place-items-center rounded-lg border border-border text-txt-muted hover:border-primary/40 hover:text-foreground"><Globe className="h-3.5 w-3.5" /></button>
                            <button onClick={() => setClosing(c)} title="Review close" className="grid h-7 w-7 place-items-center rounded-lg border border-danger/40 text-danger hover:bg-danger/10"><XIcon className="h-3.5 w-3.5" /></button>
                          </div>
                        </td>
                      </tr>
                      {/* Phase 3 — per-position heat conflict warning row (advisory only) */}
                      {showHeatWarn && (
                        <tr className="border-b border-border/50">
                          <td colSpan={12} className="pb-2 pt-0">
                            <div className={cn(
                              "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs",
                              isStandDown
                                ? "border-rose-500/40 bg-rose-500/10 text-rose-400"
                                : "border-amber-500/40 bg-amber-500/10 text-amber-400",
                            )}>
                              <Flame className="h-3 w-3 shrink-0" />
                              <span className="font-semibold">{isStandDown ? "STAND DOWN" : "High Danger"}</span>
                              <span className="text-txt-muted">—</span>
                              <span>
                                {isStandDown
                                  ? `Timing engine advises against new entries on ${c.symbol}. Consider tightening your stop-loss on this open ${c.side}.`
                                  : `Danger score ${t!.dangerScore}/100 on ${c.symbol}. Monitor this position closely.`}
                              </span>
                              <span className="ml-auto shrink-0 text-[10px] text-txt-muted">Advisory only</span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Lower grid: Exposure + Ruby Position Manager + Activity + Quick Actions */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {/* Open Exposure */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2"><Globe className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">Open Exposure</h3></div>
          {cards.length === 0 ? (
            <p className="mt-3 text-sm text-txt-muted">No open market exposure right now.</p>
          ) : (
            <div className="mt-3 space-y-3 text-sm">
              <div className="space-y-1">
                <div className="text-[11px] uppercase text-txt-muted">By Direction</div>
                <div className="flex justify-between"><span className="text-success">Long</span><span className="font-mono">{sum.longLots.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-danger">Short</span><span className="font-mono">{sum.shortLots.toFixed(2)}</span></div>
                <div className="flex justify-between border-t border-border pt-1"><span className="text-txt-secondary">Total</span><span className="font-mono">{sum.totalLots.toFixed(2)}</span></div>
              </div>
              <div className="space-y-1">
                <div className="text-[11px] uppercase text-txt-muted">By Symbol</div>
                {bySymbol.map((b) => (
                  <div key={b.symbol} className="flex justify-between"><span className="text-txt-secondary">{b.symbol}</span><span className="font-mono text-txt-muted">{b.lots.toFixed(2)} ({b.pct}%)</span></div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Ruby Position Manager */}
        <div className="rounded-2xl border border-ruby/25 bg-card p-4">
          <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-ruby" /><h3 className="text-sm font-semibold text-ruby">{name} Position Manager</h3></div>
          {cards.length === 0 ? (
            <p className="mt-3 text-sm text-txt-muted">{name} position guidance will appear when live positions are available.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {cards.slice(0, 4).map((c) => (
                <Link key={c.id} href={`/my-trades/${encodeURIComponent(c.id)}`}>
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/40 px-2.5 py-2 hover:border-ruby/40">
                    <span className="flex items-center gap-1.5 text-sm"><span className="font-mono font-semibold">{c.symbol}</span><span className={cn("text-[10px]", c.side === "BUY" ? "text-success" : "text-danger")}>{c.side}</span></span>
                    <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px]", isProtected(c) ? "border-success/40 text-success" : "border-warning/40 text-warning")}>
                      {isProtected(c) ? "All calm" : "Protect this trade"}
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 text-txt-muted" />
                  </div>
                </Link>
              ))}
            </div>
          )}
          <button onClick={openRubyLiveChat} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-2 text-sm font-medium text-ruby">
            <MessageCircle className="h-4 w-4" /> Ask {name} About All Trades
          </button>
        </div>

        {/* Live Activity */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2"><Clock className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">Live Activity</h3></div>
          </div>
          <p className="mt-3 text-sm text-txt-muted">Live activity will appear as positions update.</p>
        </div>

        {/* Quick Actions */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center gap-2"><Zap className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">Quick Actions</h3></div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button onClick={() => void load()} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-medium text-primary"><RefreshCcw className="h-3.5 w-3.5" /> Refresh</button>
            <button
              onClick={exportCsv}
              disabled={visible.length === 0}
              title={visible.length === 0 ? "No rows in the current filter to export" : "Download the currently filtered rows as CSV"}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
            ><Download className="h-3.5 w-3.5" /> Export CSV</button>
          </div>
          <p className="mt-2 text-[11px] text-txt-muted">Close a position individually from its row.</p>
        </div>
      </div>

      {closing && (
        <ConfirmCloseModal
          card={closing}
          accountType={data?.accountType ?? "unknown"}
          tradingMode={data?.tradingMode ?? "SIMULATED"}
          onClose={() => setClosing(null)}
          onClosed={() => { setClosing(null); void load(); }}
        />
      )}
      <QuickTradeModal open={openModal} onClose={() => setOpenModal(false)} onOpened={() => { setOpenModal(false); void load(); }} />
    </div>
  );
}

function Mini({ label, value, tone, sub, testId }: { label: string; value: string; tone?: string; sub?: string; testId?: string }) {
  return (
    <div data-testid={testId} className="rounded-xl border border-border bg-background/40 p-2.5">
      <div className="text-[10px] text-txt-muted">{label}</div>
      <div className={cn("text-base font-bold", tone ?? "text-foreground")}>{value}</div>
      {sub && <div className="text-[10px] text-txt-muted">{sub}</div>}
    </div>
  );
}
function Stat({ dot, label, value }: { dot: string; label: string; value: number | string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="inline-flex items-center gap-1.5 text-txt-secondary"><span className={cn("h-2 w-2 rounded-full", dot)} />{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}
function Tag({ label, tone }: { label: string; tone: string }) {
  return <span className={cn("rounded-lg border bg-background/40 px-2 py-0.5 text-[11px]", tone)}>{label}</span>;
}
function EmptyPositions({ onTrade, onScanner }: { onTrade: () => void; onScanner: () => void }) {
  const { name } = useAssistantName();
  return (
    <div className="py-10 text-center">
      <p className="text-sm font-medium text-foreground">No open trades right now.</p>
      <p className="mt-1 text-xs text-txt-muted">MT5-confirmed live positions will appear here once opened.</p>
      <div className="mt-3 flex justify-center gap-2">
        <button onClick={onTrade} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary/90">Open Trade</button>
        <button onClick={onScanner} className="rounded-lg border border-border px-3 py-1.5 text-xs text-foreground hover:border-primary/40">Open Scanner</button>
        <button onClick={openRubyLiveChat} className="rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-1.5 text-xs text-ruby">Ask {name}</button>
      </div>
    </div>
  );
}
