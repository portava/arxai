// Economic Calendar — provider-unified data path.
//
// Event list source (single endpoint, no drift):
//   - When the active calendar provider (selected by `ECONOMIC_CALENDAR_PROVIDER`
//     with its matching key) returns connected:true, the event list comes from
//     the SAME `/api/economic-calendar/events` response as the provider status
//     banner. There is no separate `/api/economic-events` call in the connected
//     path. The provider label is rendered from the response, never hardcoded.
//   - When the provider is not connected, falls back to the DB sync path
//     (`/api/economic-events`) for manually-synced events.
//   This matches the backend contract in newsCalendar.ts which describes
//   `/api/economic-calendar/events` as the unified primary endpoint.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { NewsRiskSection } from "@/components/news";
import {
  Calendar, Sparkles, Settings, ShieldAlert, Search, Clock, ChevronRight,
  ChevronDown, Bell, Eye, TrendingUp, RefreshCcw, MessageCircle, Target,
  CalendarClock, Quote, Flame,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { safeDate, formatEventTimeParts } from "@/lib/safeFormat";
import { useChartSymbol } from "@/lib/use-chart-symbol";
import { useAssistantName } from "@/lib/assistant-name";
import { useGetTimingBrainMulti, getGetTimingBrainMultiQueryKey } from "@workspace/api-client-react";

// ── DB-path event shape (from /api/economic-events) ───────────────────────
interface EconomicEvent {
  id: number; eventName: string; country: string; currency: string;
  impactLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  forecast: string | null; previous: string | null; actual: string | null;
  eventTime: string; source: string;
  affectedSymbols: string[] | null;
  volatilityFlag: number;
}

// ── Live-provider event shape (from /api/economic-calendar/events) ─────────
// Matches CalendarEventFull from the backend adapter.
interface LiveCalendarEvent {
  id: string;
  title: string;
  currency: string;
  impact: "low" | "medium" | "high";
  eventTimeIso: string;
  eventTimeUtc: string;
  affectedMarkets: string[];
  affectedSymbols: string[];
  country: string;
  source: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  riskNote: string | null;
}

// ── Unified display event (normalises both sources) ────────────────────────
type ImpactLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
interface DisplayEvent {
  key: string;
  eventName: string;
  country: string;
  currency: string;
  impactLevel: ImpactLevel;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  eventTime: string;
  affectedSymbols: string[] | null;
  volatilityFlag: number;
  riskNote?: string | null;
}

const IMPACT_UP: Record<string, ImpactLevel> = {
  low: "LOW", medium: "MEDIUM", high: "HIGH", critical: "CRITICAL",
};

function fromLive(e: LiveCalendarEvent): DisplayEvent {
  return {
    key: e.id,
    eventName: e.title,
    country: e.country,
    currency: e.currency,
    impactLevel: IMPACT_UP[e.impact] ?? "LOW",
    forecast: e.forecast,
    previous: e.previous,
    actual: e.actual,
    eventTime: e.eventTimeUtc ?? e.eventTimeIso,
    affectedSymbols: e.affectedSymbols.length > 0 ? e.affectedSymbols : (e.affectedMarkets.length > 0 ? e.affectedMarkets : null),
    volatilityFlag: 0,
    riskNote: e.riskNote,
  };
}

function fromDb(e: EconomicEvent): DisplayEvent {
  return { ...e, key: String(e.id) };
}

// Open the existing Ruby live chat (same cross-tab mechanism the AI hub uses).
const RUBY_OPEN_KEY = "arx.assistant.open.v2";
function openRubyLiveChat() {
  try {
    sessionStorage.setItem(RUBY_OPEN_KEY, "1");
    window.dispatchEvent(new StorageEvent("storage", { key: RUBY_OPEN_KEY }));
  } catch { /* sessionStorage unavailable — silent */ }
}

const IMPACT_TONE: Record<ImpactLevel, { text: string; dot: string; chip: string; label: string }> = {
  CRITICAL: { text: "text-[#E11D48]", dot: "bg-[#E11D48]", chip: "border-[#E11D48]/40 bg-[#E11D48]/10 text-[#E11D48]", label: "Critical" },
  HIGH:     { text: "text-warning",   dot: "bg-warning",   chip: "border-warning/40 bg-warning/10 text-warning",       label: "High" },
  MEDIUM:   { text: "text-warning",dot: "bg-warning",chip: "border-warning/40 bg-warning/10 text-warning", label: "Medium" },
  LOW:      { text: "text-primary",   dot: "bg-primary",   chip: "border-primary/40 bg-primary/10 text-primary",       label: "Low" },
};
const IMPACT_RANK: Record<ImpactLevel, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

function impactDots(level: ImpactLevel) {
  const n = IMPACT_RANK[level] + 1; // 2..5 filled
  const tone = IMPACT_TONE[level];
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <span key={i} className={cn("h-1.5 w-1.5 rounded-full", i < n ? tone.dot : "bg-secondary")} />
      ))}
    </span>
  );
}

function timeUntil(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = t - Date.now();
  const past = diff < 0;
  const mins = Math.round(Math.abs(diff) / 60000);
  if (mins < 60) return past ? `${mins}m ago` : `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return past ? `${hrs}h ago` : `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  return past ? `${days}d ago` : `in ${days}d`;
}
function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
// Explicit UTC time for an event (provider times are UTC). Rendered alongside
// the local time so the calendar never shows an ambiguous bare clock value.
function utcTime(iso: string): string {
  const parts = formatEventTimeParts(iso);
  return parts ? parts.utcLabel : "—";
}
function isSameDay(iso: string, ref: Date): boolean {
  const d = new Date(iso);
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate();
}

// Phase 3 — timing heat strip for an expanded event row.
// Fetches real timing-engine reads for the event's affected symbols.
// Advisory only, fail-open (absent when no symbols or data unavailable).
function EventTimingHeat({ affectedSymbols }: { affectedSymbols: string[] }) {
  const symbols = affectedSymbols.slice(0, 6);
  const joined = symbols.join(",");
  const params = { symbols: joined };
  const q = useGetTimingBrainMulti(params, {
    query: { queryKey: getGetTimingBrainMultiQueryKey(params), enabled: symbols.length > 0, staleTime: 30_000, refetchInterval: 60_000 },
  });
  const results = (q.data as { results?: Array<{ symbol?: string; timingGrade?: string; entryPermission?: string; heatScore?: number; tradeabilityScore?: number; heatState?: string }> } | undefined)?.results;
  if (!results || results.length === 0) return null;

  const permColor: Record<string, string> = {
    GO: "border-success/40 bg-success/10 text-success",
    WAIT_FOR_ENTRY: "border-warning/40 bg-warning/10 text-warning",
    WAIT_NEWS: "border-warning/40 bg-warning/10 text-warning",
    NO_TRADE: "border-danger/40 bg-danger/10 text-danger",
    STAND_DOWN: "border-danger/50 bg-danger/15 text-danger",
  };
  return (
    <div className="mt-2 rounded-lg border border-border/50 bg-background/30 p-2">
      <div className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-txt-muted">
        <Flame className="h-3 w-3" /> Affected Market Heat — advisory
      </div>
      <div className="flex flex-wrap gap-2">
        {results.map((r) => (
          <div key={r.symbol} className={cn("flex items-center gap-1.5 rounded border px-2 py-1 text-[11px]", permColor[r.entryPermission ?? ""] ?? "border-border text-txt-secondary")}>
            <span className="font-mono font-semibold">{r.symbol}</span>
            <span className="text-txt-muted">|</span>
            <span className="font-bold">{r.timingGrade ?? "—"}</span>
            <span className="text-txt-muted">·</span>
            <span>{(r.entryPermission ?? "").replace(/_/g, " ")}</span>
            {r.heatScore != null && (
              <span className="text-[10px] text-txt-muted">H:{r.heatScore}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Display label for a raw provider id. Provider-agnostic: the active provider
// is whatever the backend reports (driven by ECONOMIC_CALENDAR_PROVIDER), never
// hardcoded in the UI. A new provider only needs an entry here.
const PROVIDER_LABELS: Record<string, string> = {
  fred: "FRED",
  trading_economics: "Trading Economics",
};
function providerLabel(provider: string | undefined | null): string {
  if (!provider || provider === "none") return "Live calendar provider";
  return PROVIDER_LABELS[provider] ?? provider;
}

// Unified response shape from /api/economic-calendar/events.
// Contains both provider status AND the event list — single source of truth.
interface LiveCalendarResponse {
  connected: boolean;
  provider: string;
  configured: boolean;
  eventCount: number;
  lastFetchAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  freshnessStatus: "fresh" | "stale" | "unavailable";
  events: LiveCalendarEvent[];
}

// Page tabs (surface consolidation item E — calendar + news risk are ONE
// surface). "calendar" keeps the unified economic-calendar body; "news-risk"
// hosts the folded News Risk surface (components/news/NewsRiskSection). The
// initial tab honours ?tab= so the retired /news-risk route can deep-link.
const CAL_TABS = ["calendar", "news-risk"] as const;
type CalTabKey = (typeof CAL_TABS)[number];

function initialCalTab(): CalTabKey {
  if (typeof window === "undefined") return "calendar";
  const t = new URLSearchParams(window.location.search).get("tab");
  return (CAL_TABS as readonly string[]).includes(t ?? "") ? (t as CalTabKey) : "calendar";
}

export default function EconomicCalendarPage() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [, setChartSymbol] = useChartSymbol();
  const { name } = useAssistantName();
  const [tab, setTab] = useState<CalTabKey>(initialCalTab);

  // Filters (existing currency/impact/days preserved; date + search added client-side)
  const [currency, setCurrency] = useState<string>("");
  const [impact, setImpact] = useState<string>("");
  const [days, setDays] = useState<number>(7);
  const [dateRange, setDateRange] = useState<"today" | "tomorrow" | "week">("today");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Primary query: /api/economic-calendar/events returns BOTH provider status
  // AND event list in a single response. When connected:true, we use the events
  // from this response directly — no second endpoint call, no drift.
  const providerStatus = useQuery<LiveCalendarResponse>({
    queryKey: ["economic-calendar-provider-status", days, currency, impact],
    queryFn: async () => {
      const params = new URLSearchParams({ daysAhead: String(days) });
      if (currency) params.set("currencies", currency);
      // CRITICAL is an internal DB-level tier; live endpoint only accepts low|medium|high.
      // Map CRITICAL → high so users get the tightest real filter without a 400.
      const liveImpact = impact === "CRITICAL" ? "high" : impact.toLowerCase() as "low" | "medium" | "high";
      if (liveImpact) params.set("impact", liveImpact);
      const r = await fetch(`/api/economic-calendar/events?${params}`);
      if (!r.ok) throw new Error("provider status unavailable");
      return r.json();
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  const isConnected = providerStatus.data?.connected === true;

  // DB fallback query: only fires when the live provider is not connected.
  // When connected, the event list comes directly from providerStatus.data.events.
  const dbEvents = useQuery<{ events: EconomicEvent[] }>({
    queryKey: ["eco-events-db", currency, impact, days],
    // Activate fallback when: (a) provider explicitly says not connected, or
    // (b) the provider-status fetch itself errored (network/500 etc.) — either
    // way we fall through to the DB so the page never ends up blank.
    enabled: (providerStatus.data !== undefined || providerStatus.isError) && !isConnected,
    queryFn: async () => {
      const params = new URLSearchParams({ days: String(days) });
      if (currency) params.set("currency", currency);
      if (impact)   params.set("impact", impact);
      const r = await fetch(`/api/economic-events?${params}`);
      if (!r.ok) throw new Error("Failed to load events");
      return r.json();
    },
  });

  const sync = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/economic-events/sync", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ daysAhead: 14 }),
      });
      if (!r.ok) throw new Error("sync failed");
      return r.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["eco-events-db"] });
      void qc.invalidateQueries({ queryKey: ["economic-calendar-provider-status"] });
    },
  });

  // Unified event list: live source when connected, DB fallback otherwise.
  // Both branches return DisplayEvent — no shape drift between the two paths.
  const allEvents = useMemo((): DisplayEvent[] => {
    if (isConnected) {
      const live = (providerStatus.data?.events ?? []).map(fromLive);
      live.sort((a, b) => new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime());
      return live;
    }
    const db = (dbEvents.data?.events ?? []).map(fromDb);
    db.sort((a, b) => new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime());
    return db;
  }, [isConnected, providerStatus.data?.events, dbEvents.data]);

  // Client-side date + search refinement on top of the server query.
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const filtered = useMemo(() => {
    return allEvents.filter((e) => {
      if (dateRange === "today" && !isSameDay(e.eventTime, now)) return false;
      if (dateRange === "tomorrow" && !isSameDay(e.eventTime, tomorrow)) return false;
      if (query && !`${e.eventName} ${e.currency} ${e.country}`.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [allEvents, dateRange, query]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived summary (from real loaded events only) ────────────────────────
  const summary = useMemo(() => {
    const dayEvents = allEvents.filter((e) => isSameDay(e.eventTime, now));
    const critical = dayEvents.filter((e) => e.impactLevel === "CRITICAL").length;
    const high = dayEvents.filter((e) => e.impactLevel === "HIGH").length;
    const upcoming = dayEvents.filter((e) => new Date(e.eventTime).getTime() > Date.now());
    const next = upcoming[0] ?? null;
    const maxRank = dayEvents.reduce((m, e) => Math.max(m, IMPACT_RANK[e.impactLevel]), 0);
    const overall = maxRank >= 4 ? "Critical" : maxRank === 3 ? "High" : maxRank === 2 ? "Medium" : maxRank === 1 ? "Low" : "Low";
    const overallTone = maxRank >= 4 ? "text-[#E11D48]" : maxRank === 3 ? "text-warning" : maxRank === 2 ? "text-warning" : "text-primary";
    const affected = next?.affectedSymbols ?? [];
    return { count: dayEvents.length, critical, high, next, overall, overallTone, affected };
  }, [allEvents]); // eslint-disable-line react-hooks/exhaustive-deps

  // Markets to watch — derived from the next/high-impact events' affected symbols.
  const marketsToWatch = useMemo(() => {
    const seen = new Map<string, { symbol: string; reason: string; risk: ImpactLevel }>();
    for (const e of allEvents.filter((x) => isSameDay(x.eventTime, now) && IMPACT_RANK[x.impactLevel] >= 2)) {
      for (const sym of e.affectedSymbols ?? []) {
        if (!seen.has(sym) || IMPACT_RANK[e.impactLevel] > IMPACT_RANK[seen.get(sym)!.risk]) {
          seen.set(sym, { symbol: sym, reason: `${e.currency} event impact`, risk: e.impactLevel });
        }
      }
    }
    return Array.from(seen.values()).slice(0, 6);
  }, [allEvents]); // eslint-disable-line react-hooks/exhaustive-deps

  // Upcoming high-impact beyond today.
  const upcomingHigh = useMemo(
    () => allEvents.filter((e) => !isSameDay(e.eventTime, now) && IMPACT_RANK[e.impactLevel] >= 3).slice(0, 6),
    [allEvents], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Recent released events with actuals.
  const recentReactions = useMemo(
    () => allEvents.filter((e) => e.actual != null && new Date(e.eventTime).getTime() <= Date.now()).slice(-5).reverse(),
    [allEvents],
  );

  const goScanner = (sym?: string) => { if (sym) setChartSymbol(sym); navigate("/market-scanner"); };
  const focusMarket = (sym: string) => setChartSymbol(sym);
  const prepareTrade = (sym?: string) => { if (sym) setChartSymbol(sym); navigate("/trade-command-room"); };

  const todayLabel = now.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 pb-32 md:pb-6">
      {/* Hero */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
            <Calendar className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Economic Calendar</h1>
            <p className="text-sm text-txt-secondary">Track high-impact events, market risk, and {name}’s trade guidance.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={openRubyLiveChat} className="inline-flex items-center gap-2 rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-2 text-sm font-medium text-ruby hover:bg-ruby/15">
            <MessageCircle className="h-4 w-4" /> Ask {name}
          </button>
          <button onClick={() => setSettingsOpen((v) => !v)} className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:border-primary/40">
            <Settings className="h-4 w-4" /> Calendar Settings
          </button>
        </div>
      </div>

      {/* Calendar / News Risk tabs — the folded news-risk surface keeps its
          own honest components; the calendar body is unchanged underneath. */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as CalTabKey)}>
        <TabsList>
          <TabsTrigger value="calendar" data-testid="economic-calendar-tab-calendar">Calendar</TabsTrigger>
          <TabsTrigger value="news-risk" data-testid="economic-calendar-tab-news-risk">News Risk</TabsTrigger>
        </TabsList>
        <TabsContent value="calendar" className="mt-4 space-y-4">

      {/* Provider status banner — honesty gate.
          Not configured → "manual events only" warning.
          Configured but disconnected → soft warning (key set, fetch failing).
          Connected → success chip (collapsed by default).
          Never shows when providerStatus is still loading. */}
      {!providerStatus.isLoading && providerStatus.data && (
        providerStatus.data.configured ? (
          providerStatus.data.connected ? (
            <div className="flex items-center gap-2 rounded-xl border border-success/25 bg-success/5 px-4 py-2.5 text-xs text-success">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_4px_1px_rgba(52,211,153,0.4)]" />
              <span className="font-semibold">{providerLabel(providerStatus.data.provider)} connected</span>
              <span className="text-success">·</span>
              <span className="text-success">
                {providerStatus.data.eventCount} event{providerStatus.data.eventCount !== 1 ? "s" : ""} in window
                {providerStatus.data.lastFetchAt && ` · fetched ${new Date(providerStatus.data.lastFetchAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
              </span>
            </div>
          ) : (
            <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-2.5 text-xs text-warning">
              <span className="font-semibold">{providerLabel(providerStatus.data.provider)} is configured but the last fetch failed.</span>{" "}
              Calendar events below are from the local database (last Sync). Click "Sync events" to retry.
              {providerStatus.data.lastErrorMessage && (
                <span className="block mt-1 font-mono text-warning/70">{providerStatus.data.lastErrorMessage}</span>
              )}
            </div>
          )
        ) : (
          <div className="rounded-xl border border-border/40 bg-muted/30 px-4 py-2.5 text-xs text-txt-secondary">
            <span className="font-semibold text-txt-secondary">No live calendar provider configured.</span>{" "}
            Events shown below are manually-synced only. Configure an economic calendar provider to
            enable live data. The absence of an event is{" "}
            <span className="font-semibold text-foreground">not an all-clear</span>.
          </div>
        )
      )}

      {settingsOpen && (
        <div className="rounded-2xl border border-border bg-card p-4 text-sm text-txt-secondary">
          <div className="flex items-center justify-between">
            <span className="font-medium text-foreground">Calendar Settings</span>
            <button onClick={() => sync.mutate()} disabled={sync.isPending} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs hover:border-primary/40 disabled:opacity-50">
              <RefreshCcw className={cn("h-3.5 w-3.5", sync.isPending && "animate-spin")} /> {sync.isPending ? "Syncing…" : "Sync events"}
            </button>
          </div>
          <p className="mt-2">More calendar settings will appear here.</p>
        </div>
      )}

      {/* Today's Market Risk */}
      <div className="rounded-2xl border border-border bg-card p-5">
        {allEvents.length === 0 && !providerStatus.isLoading && !dbEvents.isLoading ? (
          <div className="text-sm text-txt-secondary">No major events found for today.</div>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-txt-muted">Today’s Market Risk</div>
              <div className="mt-3 flex items-center gap-6">
                <div className="flex items-center gap-3">
                  <span className={cn("grid h-12 w-12 place-items-center rounded-full ring-1",
                    summary.overall === "Critical" ? "bg-[#E11D48]/15 text-[#E11D48] ring-[#E11D48]/30"
                    : summary.overall === "High" ? "bg-warning/15 text-warning ring-warning/30"
                    : summary.overall === "Medium" ? "bg-warning/15 text-warning ring-warning/30"
                    : "bg-primary/15 text-primary ring-primary/30")}>
                    <ShieldAlert className="h-6 w-6" />
                  </span>
                  <div>
                    <div className={cn("text-xl font-bold", summary.overallTone)}>{summary.overall}</div>
                    <div className="text-xs text-txt-muted">Overall Risk</div>
                  </div>
                </div>
                <div className="flex gap-5">
                  <div className="text-center"><div className="text-2xl font-bold text-[#E11D48]">{summary.critical}</div><div className="text-[11px] text-txt-muted">Critical<br/>Events</div></div>
                  <div className="text-center"><div className="text-2xl font-bold text-warning">{summary.high}</div><div className="text-[11px] text-txt-muted">High<br/>Impact</div></div>
                  <div className="text-center"><div className="text-2xl font-bold text-foreground">{summary.count}</div><div className="text-[11px] text-txt-muted">Total<br/>Events</div></div>
                </div>
              </div>
            </div>
            <div className="lg:border-l lg:border-border lg:pl-5">
              <div className="text-[11px] text-txt-muted">Next Event</div>
              {summary.next ? (
                <>
                  <div className="mt-0.5 text-lg font-bold">{summary.next.eventName}</div>
                  <div className="text-sm text-warning">{timeUntil(summary.next.eventTime)}</div>
                  <div className="text-[11px] text-txt-muted">{utcTime(summary.next.eventTime)} · {clockTime(summary.next.eventTime)} local</div>
                  <div className="mt-3 text-[11px] text-txt-muted">Affected Markets</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {(summary.affected.slice(0, 4)).map((s) => (
                      <span key={s} className="rounded-md border border-border bg-secondary/60 px-2 py-0.5 text-xs text-txt-secondary">{s}</span>
                    ))}
                    {summary.affected.length > 4 && <span className="rounded-md border border-border bg-secondary/60 px-2 py-0.5 text-xs text-txt-muted">+{summary.affected.length - 4}</span>}
                    {summary.affected.length === 0 && <span className="text-xs text-txt-muted">No affected markets identified yet.</span>}
                  </div>
                </>
              ) : (
                <div className="mt-1 text-sm text-txt-secondary">No more events scheduled today.</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Filter bar */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {([["today","Today"],["tomorrow","Tomorrow"],["week","This Week"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => { setDateRange(k); setDays(k === "week" ? 7 : 1); }}
              className={cn("rounded-lg border px-3 py-1.5 text-sm", dateRange === k ? "border-primary bg-primary text-white" : "border-border bg-card text-txt-secondary hover:text-foreground")}>
              {label}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-border" />
          {["USD","EUR","JPY","GBP"].map((c) => (
            <button key={c} onClick={() => setCurrency(currency === c ? "" : c)}
              className={cn("rounded-lg border px-3 py-1.5 text-sm", currency === c ? "border-primary bg-primary text-white" : "border-border bg-card text-txt-secondary hover:text-foreground")}>
              {c}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-border" />
          {([["","All"],["HIGH","High"],["CRITICAL","Critical"]] as const).map(([k, label]) => (
            <button key={label} onClick={() => setImpact(k)}
              className={cn("rounded-lg border px-3 py-1.5 text-sm",
                impact === k ? (k === "CRITICAL" ? "border-[#E11D48] bg-[#E11D48]/15 text-[#E11D48]" : k === "HIGH" ? "border-warning bg-warning/15 text-warning" : "border-primary bg-primary text-white")
                : "border-border bg-card text-txt-secondary hover:text-foreground")}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-txt-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search events…"
              className="w-full rounded-lg border border-border bg-card pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm text-txt-secondary">
            <Clock className="h-4 w-4" /> Timezone: {tz}
          </span>
        </div>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Timeline */}
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">Today · {todayLabel}</div>
            <div className="mt-3 space-y-1">
              {(providerStatus.isLoading || dbEvents.isLoading) && <p className="py-6 text-center text-sm text-txt-muted">Loading events…</p>}
              {!providerStatus.isLoading && !dbEvents.isLoading && filtered.length === 0 && (
                <p className="py-6 text-center text-sm text-txt-muted">No events match these filters.</p>
              )}
              {filtered.map((e) => {
                const tone = IMPACT_TONE[e.impactLevel];
                const released = e.actual != null && new Date(e.eventTime).getTime() <= Date.now();
                const isOpen = expanded === e.key;
                return (
                  <div key={e.key} className={cn("rounded-xl border p-3 transition-colors",
                    isOpen ? "border-primary/40 bg-background/40" : "border-transparent hover:bg-background/30")}>
                    <button onClick={() => setExpanded(isOpen ? null : e.key)} className="flex w-full items-start gap-3 text-left">
                      <div className="w-24 shrink-0">
                        <div className="text-sm font-semibold">{clockTime(e.eventTime)} <span className="text-[10px] font-normal text-txt-muted">local</span></div>
                        <div className="text-[11px] text-txt-muted">{utcTime(e.eventTime)}</div>
                        <div className="text-[11px] text-txt-muted">{timeUntil(e.eventTime)}</div>
                      </div>
                      <span className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-full", tone.dot)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase", tone.chip)}>{tone.label}</span>
                          <span className="text-xs text-txt-muted">{e.currency}</span>
                        </div>
                        <div className="mt-0.5 text-sm font-semibold text-foreground">{e.eventName}</div>
                        {e.affectedSymbols && e.affectedSymbols.length > 0 && (
                          <div className="mt-0.5 text-[11px] text-txt-muted">
                            Affects: <span className="text-primary">{e.affectedSymbols.join(", ")}</span>
                          </div>
                        )}
                      </div>
                      <div className="hidden shrink-0 items-center gap-4 text-right text-xs sm:flex">
                        <div><div className="text-txt-muted">Prev</div><div className="text-foreground">{e.previous ?? "—"}</div></div>
                        <div><div className="text-txt-muted">Forecast</div><div className="text-foreground">{e.forecast ?? "—"}</div></div>
                        <div><div className="text-txt-muted">Actual</div><div className={cn(released ? "text-success" : "text-txt-muted")}>{released ? e.actual : "—"}</div></div>
                        <div className="w-12">{released ? <span className="text-success">↑</span> : impactDots(e.impactLevel)}</div>
                      </div>
                      <ChevronDown className={cn("mt-1 h-4 w-4 shrink-0 text-txt-muted transition-transform", isOpen && "rotate-180")} />
                    </button>
                    {isOpen && (
                      <div className="mt-3 border-t border-border pt-3">
                        <div className="grid grid-cols-3 gap-2 text-xs sm:hidden">
                          <div><div className="text-txt-muted">Prev</div><div>{e.previous ?? "—"}</div></div>
                          <div><div className="text-txt-muted">Forecast</div><div>{e.forecast ?? "—"}</div></div>
                          <div><div className="text-txt-muted">Actual</div><div>{released ? e.actual : "—"}</div></div>
                        </div>
                        {/* Phase 3 — News phase chip (derived from event timing) + real timing-engine heat */}
                        {(() => {
                          const msSince = Date.now() - new Date(e.eventTime).getTime();
                          const minsBefore = -msSince / 60000;
                          const minsAfter = msSince / 60000;
                          const hasActual = e.actual != null;
                          const phase: string | null =
                            minsAfter >= 60 && hasActual ? "SETTLED"
                            : minsAfter >= 0 && hasActual ? "POST_EVENT"
                            : minsBefore <= 5 && minsBefore >= -5 ? "AT_EVENT"
                            : minsBefore > 0 && minsBefore <= 30 ? "PRE_EVENT"
                            : null;
                          const surpNumer = e.actual && e.forecast ? parseFloat(e.actual) - parseFloat(e.forecast) : null;
                          const hasSurprise = surpNumer != null && !Number.isNaN(surpNumer);
                          const phaseLabel: Record<string, string> = {
                            PRE_EVENT: "Pre-event window",
                            AT_EVENT: "Live now",
                            POST_EVENT: "Post-event settling",
                            SETTLED: "Market settled",
                          };
                          const phaseColor: Record<string, string> = {
                            PRE_EVENT: "border-warning/40 bg-warning/10 text-warning",
                            AT_EVENT: "border-danger/40 bg-danger/10 text-danger",
                            POST_EVENT: "border-warning/40 bg-warning/10 text-warning",
                            SETTLED: "border-success/40 bg-success/10 text-success",
                          };
                          if (!phase && !hasSurprise) return null;
                          return (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              {phase && (
                                <span className={cn("inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-semibold", phaseColor[phase] ?? "")}>
                                  <Clock className="h-3 w-3" />
                                  {phaseLabel[phase]}
                                </span>
                              )}
                              {hasSurprise && (
                                <span className={cn(
                                  "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold",
                                  surpNumer! > 0 ? "border-success/40 bg-success/10 text-success"
                                    : "border-danger/40 bg-danger/10 text-danger",
                                )}>
                                  Surprise: {surpNumer! > 0 ? "+" : ""}{surpNumer!.toFixed(2)}
                                </span>
                              )}
                            </div>
                          );
                        })()}
                        {/* Phase 3 — Real timing-engine heat for affected symbols */}
                        {isOpen && e.affectedSymbols && e.affectedSymbols.length > 0 && (
                          <EventTimingHeat affectedSymbols={e.affectedSymbols} />
                        )}
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button onClick={openRubyLiveChat} className="inline-flex items-center gap-1.5 rounded-lg border border-ruby/40 bg-ruby/10 px-2.5 py-1 text-xs text-ruby">
                            <MessageCircle className="h-3.5 w-3.5" /> Ask {name}
                          </button>
                          <button onClick={() => goScanner(e.affectedSymbols?.[0])} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-foreground hover:border-primary/40">
                            <Search className="h-3.5 w-3.5" /> Open Scanner
                          </button>
                          <button onClick={() => prepareTrade(e.affectedSymbols?.[0])} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-foreground hover:border-primary/40">
                            <Target className="h-3.5 w-3.5" /> Prepare Trade
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <button onClick={() => { setDateRange("week"); setDays(14); }} className="mt-2 flex w-full items-center justify-between rounded-xl border border-border px-3 py-2.5 text-sm text-txt-secondary hover:border-primary/40">
              <span className="inline-flex items-center gap-2"><CalendarClock className="h-4 w-4" /> View Full Calendar</span>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Recent Event Reactions */}
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center gap-2"><TrendingUp className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">Recent Event Reactions</h3></div>
            <div className="mt-3 space-y-2">
              {recentReactions.length === 0 ? (
                <p className="text-xs text-txt-muted">Event reactions will appear after releases are tracked.</p>
              ) : recentReactions.map((e) => (
                <div key={e.key} className="flex items-center justify-between gap-2 text-xs">
                  <span className="w-28 shrink-0 text-txt-muted">{safeDate(e.eventTime)}</span>
                  <span className="flex-1 truncate text-foreground">{e.eventName}</span>
                  <span className="text-txt-secondary">A {e.actual} vs F {e.forecast ?? "—"}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right rail */}
        <div className="space-y-4">
          {/* Ruby's News Read */}
          <div className="rounded-2xl border border-ruby/25 bg-card p-4">
            <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-ruby" /><h3 className="text-sm font-semibold text-ruby">{name}’s News Read</h3></div>
            {summary.next ? (
              <>
                <div className="mt-2 flex gap-2 text-sm text-txt-secondary">
                  <Quote className="h-4 w-4 shrink-0 text-ruby/70" />
                  <p>{summary.next.eventName} {timeUntil(summary.next.eventTime)}. Risk is {summary.overall.toLowerCase()} — major releases can move {summary.next.currency} pairs quickly. Best action: wait for the first reaction, then let Scanner confirm direction.</p>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {["Wait","Reduce Size","Avoid Scalp","Watch Spread","Confirm After"].map((g) => (
                    <span key={g} className="rounded-lg border border-border bg-secondary/60 px-2 py-0.5 text-[11px] text-txt-secondary">{g}</span>
                  ))}
                </div>
              </>
            ) : (
              <p className="mt-2 text-sm text-txt-muted">{name} is waiting for calendar data.</p>
            )}
            <button onClick={openRubyLiveChat} className="mt-3 flex w-full items-center justify-between rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-2 text-sm font-medium text-ruby">
              <span className="inline-flex items-center gap-1.5"><MessageCircle className="h-4 w-4" /> Ask {name}</span>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Markets to Watch */}
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center gap-2"><Eye className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">Markets to Watch</h3></div>
            <div className="mt-3 space-y-2">
              {marketsToWatch.length === 0 ? (
                <p className="text-xs text-txt-muted">No affected markets identified yet.</p>
              ) : marketsToWatch.map((m) => (
                <div key={m.symbol} className="flex items-center justify-between gap-2 text-xs">
                  <button onClick={() => focusMarket(m.symbol)} className="font-semibold text-foreground hover:text-primary">{m.symbol}</button>
                  <span className="flex-1 truncate px-2 text-txt-muted">{m.reason}</span>
                  <span className={cn("font-medium", IMPACT_TONE[m.risk].text)}>{IMPACT_TONE[m.risk].label}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button onClick={() => goScanner()} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90">
                <Search className="h-4 w-4" /> Open Scanner
              </button>
              <button onClick={() => marketsToWatch[0] && focusMarket(marketsToWatch[0].symbol)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:border-primary/40">
                <Target className="h-4 w-4" /> Focus Market
              </button>
            </div>
          </div>

          {/* Upcoming High Impact */}
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center gap-2"><CalendarClock className="h-4 w-4 text-warning" /><h3 className="text-sm font-semibold">Upcoming High Impact</h3></div>
            <div className="mt-3 space-y-2">
              {upcomingHigh.length === 0 ? (
                <p className="text-xs text-txt-muted">No high-impact events ahead in this window.</p>
              ) : upcomingHigh.map((e) => (
                <div key={e.key} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 text-txt-muted">{clockTime(e.eventTime)} local<br />{utcTime(e.eventTime)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground">{e.eventName}</div>
                    <div className="text-txt-muted">{e.currency}</div>
                  </div>
                  <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-semibold", IMPACT_TONE[e.impactLevel].chip)}>{IMPACT_TONE[e.impactLevel].label}</span>
                  <span className="w-12 shrink-0 text-right text-txt-muted">{timeUntil(e.eventTime)}</span>
                </div>
              ))}
            </div>
            <button onClick={() => { setDateRange("week"); setDays(14); }} className="mt-3 flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-sm text-txt-secondary hover:border-primary/40">
              <span>View Full Calendar</span><ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Event Alerts.
          Constraint: there is no server endpoint that creates or schedules
          per-user calendar reminders (meNotifications exposes read/dismiss/
          preference surfaces only; /api/notifications/* has no user-facing
          create/schedule route). The previous offset/channel chips here were
          non-functional placebos, so they were removed rather than faked —
          this card now states plainly what exists and links to the real
          alerts inbox. */}
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><Bell className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">Event Alerts</h3></div>
          <button onClick={() => navigate("/alerts")} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">Manage Alerts <ChevronRight className="h-3 w-3" /></button>
        </div>
        <p className="mt-2 text-xs text-txt-secondary">
          Scheduled event reminders don't exist yet — there is no reminder service to
          wire this page to, so no reminder controls are shown. Calendar and news
          alerts that ARX does generate arrive in your alerts inbox.
        </p>
      </div>

        </TabsContent>
        <TabsContent value="news-risk" className="mt-4">
          <NewsRiskSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
