import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarDays, RefreshCcw, TrendingUp, TrendingDown, Minus, Calendar as CalIcon } from "lucide-react";

interface CalendarDay {
  date: string;
  net_pnl: number;
  total_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  /**
   * null = not rated: nothing closed that day (not graded), or no rating was
   * computed for it (the live route does not grade days).
   */
  day_rating: "A" | "B" | "C" | "D" | "F" | null;
  /**
   * PNL_NOT_RECORDED_DAY: some closed trades that day have no recorded P&L
   * yet, so the day is neither a measured win, loss nor break-even.
   * NOT_SIZED_DAY: some closes could not be sized for the instrument, so the
   * day could be up or down.
   */
  day_status: "WINNING_DAY" | "LOSING_DAY" | "BREAK_EVEN_DAY" | "NO_TRADE_DAY" | "PNL_NOT_RECORDED_DAY" | "NOT_SIZED_DAY";
  /** Closed trades that day with no recorded P&L (live route's pnlNotRecorded). */
  pnl_not_recorded?: number;
  /** Closes whose P&L could not be sized; net_pnl leaves them out. */
  unsized_trades?: number;
  debriefs_created: number;
  learning_events_created: number;
  symbols_traded: string[];
  /** The day is after today (UTC): it has not happened yet. */
  is_future?: boolean;
}
// Totals are null when the server did not compute them (a LIVE_SHARED
// session, where the paper book is withheld and live trades are not totalled).
interface CalendarResp {
  calendar: {
    month: string; days: CalendarDay[]; total_pnl: number | null; total_trades: number | null;
    winning_days: number | null; losing_days: number | null; no_trade_days: number | null;
    /** Which ledger the month was read from (server text). */
    source_note?: string;
    /** Closed trades this month with no recorded P&L (counted as 0 in total_pnl). */
    pnl_not_recorded?: number;
    /** Server note on closes whose P&L could not be sized (null when none). */
    pnl_note?: string | null;
  };
  currentAccountMode?: string;
  liveAggregation?: string;
  modeNote?: string;
  /**
   * The server answered for a LIVE_SHARED account without reading any trades
   * (an empty, mode-tagged reply). Nothing was looked up, so the page must not
   * show it as "no trades" or a 0.00 month.
   */
  notShownHere?: boolean;
}
interface DayDetailResp { day: { date: string; stats: any; trades: any[] }; currentAccountMode?: string; modeNote?: string }

const NOT_SHOWN = "Not shown";
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Which ledger this page reads, for a server that does not send its note.
// The demo calendar reads simulated orders, not the demo trades a trader
// logs by hand on My Demo Trades (/my-performance), so the two pages differ for a date.
const DEMO_SOURCE_NOTE =
  "From your simulated orders (Paper Autopilot and simulated trade tickets). Demo trades you log by hand on My Demo Trades are a separate record and are not included; their P&L is computed differently, so the two pages will not match.";
const LIVE_SOURCE_NOTE = "From your closed live trades recorded against your account.";

/**
 * A day-detail row's P&L is a realized result only when the order closed.
 * An open or cancelled order's stored 0 is not a measurement (the server
 * sends pnl null for those; an older server sent 0, which is downgraded here).
 */
function realizedPnl(t: { status?: unknown; pnl?: unknown }): number | null {
  const closed = typeof t.status === "string" && /^(PAPER_)?CLOSED/.test(t.status);
  return closed && typeof t.pnl === "number" && Number.isFinite(t.pnl) ? t.pnl : null;
}

function noPnlText(t: { status?: unknown; pnl_note?: unknown }): string {
  if (typeof t.pnl_note === "string" && t.pnl_note) return t.pnl_note;
  if (t.status === "OPEN") return "Still open — no realized P&L yet";
  if (t.status === "CANCELLED") return "Cancelled — no P&L";
  return "P&L not recorded";
}

/**
 * Profit factor (gross profit ÷ gross loss) is a number only when a losing
 * trade closed. With no loss it is undefined; an older server sent an
 * invented 9.99 (or 0) for that, which is downgraded here.
 */
function profitFactorText(stats: { profit_factor?: unknown; wins?: unknown; losses?: unknown }): string {
  const pf = stats.profit_factor;
  const losses = typeof stats.losses === "number" ? stats.losses : null;
  const wins = typeof stats.wins === "number" ? stats.wins : null;
  if (typeof pf === "number" && Number.isFinite(pf) && losses != null && losses > 0) return pf.toFixed(2);
  if (losses === 0 && wins != null && wins > 0) return "No losses (undefined)";
  return "—";
}

/** A recorded P&L, or null when the trade has none yet. */
function recordedPnl(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "1 closed trade has" / "2 closed trades have". */
function tradesHave(n: number): string {
  return n === 1 ? "1 closed trade has" : `${n} closed trades have`;
}

/** How many of a day's closes could not be sized (0 from an older server). */
function unsizedOf(d: { unsized_trades?: unknown }): number {
  return typeof d.unsized_trades === "number" && d.unsized_trades > 0 ? d.unsized_trades : 0;
}

function dayColor(d: CalendarDay) {
  switch (d.day_status) {
    case "WINNING_DAY": return "bg-emerald-500/15 border-emerald-500/40 text-emerald-300";
    case "LOSING_DAY":  return "bg-rose-500/15 border-rose-500/40 text-rose-300";
    case "BREAK_EVEN_DAY": return "bg-amber-500/15 border-amber-500/40 text-amber-300";
    default: return "bg-slate-700/20 border-slate-700/40 text-slate-400";
  }
}

// Map the LIVE mode-aware route ({ days:[{date,totalPnl,tradesCount,winRate,...}] })
// into the CalendarResp shape the existing UI renders. No paper data in LIVE mode.
// The route lists only days that had closed trades over the whole from..to
// range it read, so every other day of the month is a no-trade day. It
// computes no day rating, so live days are shown as not rated (null).
function mapLiveToCalendarResp(
  month: string,
  live: { days?: any[]; isEmpty?: boolean; currentAccountMode?: string; sourceNote?: string } | undefined,
): CalendarResp {
  const src = Array.isArray(live?.days) ? live!.days : [];
  const byDate = new Map<string, any>();
  for (const d of src) {
    if (typeof d?.date === "string" && d.date.startsWith(month)) byDate.set(d.date, d);
  }
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = y && m ? new Date(Date.UTC(y, m, 0)).getUTCDate() : 0;
  const days: CalendarDay[] = Array.from({ length: daysInMonth }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, "0")}`;
    const d = byDate.get(date) ?? {};
    const pnl = Number(d.totalPnl ?? 0);
    const trades = Number(d.tradesCount ?? 0);
    // The route counts a closed trade with no recorded P&L as 0, so such a
    // day is not a measured win, loss or break-even.
    const notRecorded = Math.min(trades, Math.max(0, Number(d.pnlNotRecorded ?? 0) || 0));
    const status: CalendarDay["day_status"] =
      trades === 0 ? "NO_TRADE_DAY" : notRecorded > 0 ? "PNL_NOT_RECORDED_DAY"
      : pnl > 0 ? "WINNING_DAY" : pnl < 0 ? "LOSING_DAY" : "BREAK_EVEN_DAY";
    return {
      date,
      net_pnl: pnl,
      total_trades: trades,
      wins: Number(d.wins ?? 0),
      losses: Number(d.losses ?? 0),
      win_rate: Number(d.winRate ?? 0),
      // The live route computes no day rating; no grade is invented or shown.
      day_rating: null,
      day_status: status,
      pnl_not_recorded: notRecorded,
      debriefs_created: 0,
      learning_events_created: 0,
      symbols_traded: [],
    };
  });
  // A LIVE_SHARED reply read no trades: its month is unknown (null totals,
  // no day cells), never a 0.00 month of no-trade days.
  if (live?.currentAccountMode === "LIVE_SHARED") {
    return {
      notShownHere: true,
      currentAccountMode: "LIVE_SHARED",
      calendar: { month, days: [], total_pnl: null, total_trades: null, winning_days: null, losing_days: null, no_trade_days: null },
    };
  }
  return {
    notShownHere: false,
    calendar: {
      month,
      days,
      total_pnl: days.reduce((s, d) => s + d.net_pnl, 0),
      total_trades: days.reduce((s, d) => s + d.total_trades, 0),
      winning_days: days.filter((d) => d.day_status === "WINNING_DAY").length,
      losing_days: days.filter((d) => d.day_status === "LOSING_DAY").length,
      no_trade_days: days.filter((d) => d.day_status === "NO_TRADE_DAY").length,
      source_note: typeof live?.sourceNote === "string" && live.sourceNote ? live.sourceNote : undefined,
      pnl_not_recorded: days.reduce((s, d) => s + (d.pnl_not_recorded ?? 0), 0),
    },
  };
}

// Every read checks the HTTP status and the payload shape: an error body (a
// 401, or a 500 carrying { error, ...SAFETY }) is a failed load, never data.
async function readJson(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url.split("?")[0]} failed: ${r.status}`);
  return r.json();
}

export default function TradingCalendarPage() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Read the live/account mode so the calendar shows LIVE trades in LIVE mode
  // and paper trades otherwise — never mixed. GET /api/me/trading/mode answers
  // { ok, envelope: { tradingMode }, perUserTradingMode: { mode } }; the
  // envelope's tradingMode is the same value the live calendar route uses to
  // pick live vs paper rows (mePerformanceCalendar.ts loadClosedRows).
  const mode = useQuery<{ ok?: boolean; envelope?: { tradingMode?: string } }>({
    queryKey: ["trading-mode-for-calendar"],
    queryFn: async () => {
      const j = await readJson("/api/me/trading/mode", { credentials: "include" });
      if (j?.ok !== true || typeof j?.envelope?.tradingMode !== "string") {
        throw new Error("/api/me/trading/mode returned no mode");
      }
      return j;
    },
  });
  const isLive = mode.data?.envelope?.tradingMode === "LIVE";

  const cal = useQuery<CalendarResp>({
    queryKey: ["trading-calendar", month, isLive],
    enabled: mode.isSuccess,
    queryFn: async () => {
      if (isLive) {
        // First/last day of the selected month for the live route's from/to.
        const from = `${month}-01`;
        const [y, m] = month.split("-").map(Number);
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const to = `${month}-${String(lastDay).padStart(2, "0")}`;
        const live = await readJson(`/api/me/performance-calendar?from=${from}&to=${to}`, { credentials: "include" });
        if (!Array.isArray(live?.days)) throw new Error("/api/me/performance-calendar returned no days");
        return mapLiveToCalendarResp(month, live);
      }
      const paper = await readJson(`/api/performance/calendar?month=${month}`);
      if (!Array.isArray(paper?.calendar?.days)) throw new Error("/api/performance/calendar returned no calendar");
      return { ...paper, notShownHere: paper?.currentAccountMode === "LIVE_SHARED" };
    },
  });
  // A failed (re)load is shown as a failure, never over older data. That
  // includes a failed mode re-check: the calendar query is then disabled and
  // keeps its earlier data, which can no longer be placed as live or demo.
  const calData = cal.isError || !mode.isSuccess ? undefined : cal.data;
  const notShownHere = calData?.notShownHere === true;

  const day = useQuery<DayDetailResp>({
    queryKey: ["trading-calendar-day", selectedDate, isLive],
    enabled: !!selectedDate && mode.isSuccess,
    queryFn: async () => {
      if (isLive) {
        const d = await readJson(`/api/me/performance-calendar/${selectedDate}`, { credentials: "include" });
        if (!Array.isArray(d?.trades)) throw new Error("/api/me/performance-calendar/:date returned no trades");
        // Map live day-agg → DayDetailResp shape the UI renders. A trade
        // whose P&L is not recorded yet stays null (never a measured 0.00).
        const trades = d.trades.map((t: any) => ({
          trade_id: t.id, symbol: t.symbol, action: t.side, status: "CLOSED",
          pnl: recordedPnl(t.pnl), decision_id: null,
          entry_price: t.entryPrice, exit_price: t.exitPrice,
          stop_loss: "—", take_profit: "—",
        }));
        const notRecorded = trades.filter((t: { pnl: number | null }) => t.pnl == null).length;
        return {
          day: {
            date: selectedDate!,
            stats: {
              net_pnl: Number(d.totalPnl ?? 0),
              total_trades: Number(d.tradesCount ?? 0),
              // The route counts an unrecorded P&L as break-even, so its win
              // rate is not a measured one while any P&L is missing.
              win_rate: notRecorded > 0 ? null : Number(d.winRate ?? 0),
              pnl_not_recorded: notRecorded,
              profit_factor: null,
              day_rating: null,
              top_lesson: null,
            },
            // A live trade with no recorded P&L stays null (never 0.00).
            trades,
          },
        } as DayDetailResp;
      }
      const paperDay = await readJson(`/api/performance/day?date=${selectedDate}`);
      if (!paperDay?.day?.stats || !Array.isArray(paperDay.day.trades)) {
        throw new Error("/api/performance/day returned no day");
      }
      return paperDay;
    },
  });

  // POST /api/performance/rebuild rewrites the saved snapshot tables
  // (performance_daily_snapshots and friends, read by the Trader Coach). This
  // calendar never reads them: GET /api/performance/calendar recomputes every
  // day from paper_orders on each load. So a rebuild changes nothing here and
  // the calendar is not reloaded as if it had been rebuilt.
  const rebuild = useMutation({
    mutationFn: async () => {
      const j = await readJson("/api/performance/rebuild", { method: "POST" });
      if (!j?.rebuild || typeof j.rebuild !== "object") throw new Error("/api/performance/rebuild returned no summary");
      return j.rebuild as { finished_at?: string; daily_snapshots_written?: number };
    },
  });

  // The server withheld the paper book for a live account (or the live route
  // did not read a shared account) and did not total live trades: show its
  // note and no numbers, rather than demo copy and 0.00.
  const totals = calData?.calendar;
  const totalPnl = num(totals?.total_pnl);
  const dayLiveWithheld = day.data?.currentAccountMode === "LIVE_SHARED";
  const days = calData?.calendar.days ?? [];
  // Pad start so day-of-week aligns.
  const firstWeekday = days[0] ? new Date(days[0].date + "T00:00:00Z").getUTCDay() : 0;

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <CalendarDays className="text-primary" /> Trading Calendar
          </h2>
          <div className="text-muted-foreground flex items-center gap-2 flex-wrap">
            {mode.isError
              ? "Your trading mode could not be loaded."
              : !mode.isSuccess
              ? "Checking your trading mode…"
              : notShownHere
              ? (
                <span data-testid="calendar-mode-note">
                  {calData?.modeNote ?? "Live trades on your shared account are not totalled on this calendar, so no figures are shown. They are not zero."}
                </span>
              )
              : isLive ? "Daily P&L and win rate from your closed live trades." : "Daily P&L, win rate, and AI activity from your simulated orders."}
          </div>
          {mode.isSuccess && !notShownHere && (
            <div className="text-xs text-muted-foreground mt-1" data-testid="calendar-source-note">
              {calData?.calendar?.source_note ?? (isLive ? LIVE_SOURCE_NOTE : DEMO_SOURCE_NOTE)}
              {!isLive && (
                <>
                  {" "}Calculated from your simulated orders each time this page loads. &ldquo;Rebuild saved snapshots&rdquo; refreshes the
                  saved daily snapshots the Trader Coach reads; it does not change this calendar.
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-sm"
            data-testid="input-month"
          />
          {mode.isSuccess && !isLive && !notShownHere && (
            <Button onClick={() => rebuild.mutate()} disabled={rebuild.isPending} data-testid="btn-rebuild">
              <RefreshCcw className={`mr-2 h-4 w-4 ${rebuild.isPending ? "animate-spin" : ""}`} />
              Rebuild saved snapshots
            </Button>
          )}
        </div>
      </div>

      {(rebuild.isSuccess || rebuild.isError) && (
        <div className={`text-xs ${rebuild.isError ? "text-rose-300" : "text-muted-foreground"}`} data-testid="rebuild-result">
          {rebuild.isError
            ? "Saved snapshots could not be rebuilt."
            : `Saved snapshots rebuilt${rebuild.data?.finished_at ? ` at ${new Date(rebuild.data.finished_at).toLocaleTimeString()}` : ""}: ${
                typeof rebuild.data?.daily_snapshots_written === "number" ? rebuild.data.daily_snapshots_written : "an unknown number of"
              } daily snapshots written. This calendar does not read them, so nothing above changed.`}
        </div>
      )}

      {mode.isError && (
        <Card className="border-border" data-testid="calendar-mode-error">
          <CardContent className="pt-4 text-sm text-muted-foreground">
            Your trading mode could not be loaded, so this page can&apos;t tell whether to show your live or demo
            calendar. Nothing is shown until it loads.
          </CardContent>
        </Card>
      )}

      {notShownHere && (
        <Card className="border-border" data-testid="calendar-not-shown">
          <CardContent className="pt-4 text-sm text-muted-foreground">
            This calendar does not read live trades on a shared account, so it has no P&amp;L to show for {month}.
            Check Live Trades or your broker statement for your live results.
          </CardContent>
        </Card>
      )}

      {totals && (() => {
        const monthNotRecorded = num(totals.pnl_not_recorded) ?? 0;
        const monthTrades = num(totals.total_trades);
        const allNotRecorded = monthNotRecorded > 0 && monthTrades != null && monthNotRecorded >= monthTrades;
        return (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Net P&L (month)</CardTitle></CardHeader>
            <CardContent data-testid="month-net-pnl">
              {monthNotRecorded > 0 ? (
                <>
                  <div data-testid="calendar-total-pnl" className="text-xl font-bold text-muted-foreground">
                    {allNotRecorded ? "Not recorded" : totalPnl == null ? NOT_SHOWN : `${totalPnl.toFixed(2)} (partial)`}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1">
                    {tradesHave(monthNotRecorded)} no recorded P&amp;L yet; those days are not counted as winning or losing days.
                  </div>
                </>
              ) : (
                <div data-testid="calendar-total-pnl" className={`text-xl font-bold ${totalPnl == null ? "text-muted-foreground" : totalPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{totalPnl == null ? NOT_SHOWN : totalPnl.toFixed(2)}</div>
              )}
            </CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Total Trades</CardTitle></CardHeader>
            <CardContent><div data-testid="calendar-total-trades" className={`text-xl font-bold ${num(totals.total_trades) == null ? "text-muted-foreground" : ""}`}>{num(totals.total_trades) ?? NOT_SHOWN}</div></CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Winning Days</CardTitle></CardHeader>
            <CardContent><div className={`text-xl font-bold ${num(totals.winning_days) == null ? "text-muted-foreground" : "text-emerald-400"}`}>{num(totals.winning_days) ?? NOT_SHOWN}</div></CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Losing Days</CardTitle></CardHeader>
            <CardContent><div className={`text-xl font-bold ${num(totals.losing_days) == null ? "text-muted-foreground" : "text-rose-400"}`}>{num(totals.losing_days) ?? NOT_SHOWN}</div></CardContent></Card>
        </div>
        );
      })()}

      {totals && typeof totals.pnl_note === "string" && totals.pnl_note && (
        <div className="text-xs text-amber-300" data-testid="calendar-pnl-note">{totals.pnl_note}</div>
      )}

      {isLive && calData && !notShownHere && num(calData.calendar.total_trades) === 0 && (
        <Card className="border-border">
          <CardContent className="pt-4 text-sm text-muted-foreground">
            No live trades recorded yet for {month}. Live P&amp;L will appear here once you place and close live trades.
          </CardContent>
        </Card>
      )}

      {!mode.isError && !notShownHere && <Card>
        <CardHeader><CardTitle>{month}</CardTitle></CardHeader>
        <CardContent>
          {cal.isError ? (
            <div className="text-sm text-rose-300" data-testid="calendar-load-error">
              The calendar for {month} could not be loaded, so no P&amp;L or trade counts are shown. Nothing is shown rather than an empty month.
            </div>
          ) : !calData ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <>
              <div className="grid grid-cols-7 gap-2 mb-2 text-xs text-center text-muted-foreground">
                {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => <div key={d}>{d}</div>)}
              </div>
              <div className="grid grid-cols-7 gap-2">
                {Array.from({ length: firstWeekday }).map((_, i) => <div key={`pad-${i}`} />)}
                {days.map(d => (
                  <button
                    key={d.date}
                    onClick={() => setSelectedDate(d.date)}
                    className={`rounded-md border p-2 text-left hover:scale-[1.02] transition ${dayColor(d)} ${selectedDate === d.date ? "ring-2 ring-primary" : ""}`}
                    data-testid={`day-${d.date}`}
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold">{Number(d.date.slice(8))}</span>
                      {d.day_rating ? (
                        <Badge variant="outline" className="text-[10px] px-1 py-0" data-testid={`day-rating-${d.date}`}>{d.day_rating}</Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 text-sm font-bold flex items-center gap-1">
                      {d.day_status === "WINNING_DAY" && <TrendingUp className="h-3 w-3" />}
                      {d.day_status === "LOSING_DAY" && <TrendingDown className="h-3 w-3" />}
                      {d.day_status === "BREAK_EVEN_DAY" && <Minus className="h-3 w-3" />}
                      {/* No figure when none of the day's closes has a recorded or sized P&L: its 0.00 is not a result. */}
                      {d.total_trades === 0 ? "—"
                        : (d.pnl_not_recorded ?? 0) >= d.total_trades ? "not recorded"
                        : (d.pnl_not_recorded ?? 0) + unsizedOf(d) >= d.total_trades ? "—"
                        : d.net_pnl.toFixed(2)}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {d.total_trades === 0 ? (d.is_future ? "not yet" : "no trades")
                        : (d.pnl_not_recorded ?? 0) > 0 ? `${d.total_trades}t · ${d.pnl_not_recorded} P&L not recorded`
                        : `${d.total_trades}t · ${d.win_rate.toFixed(0)}%w`}
                      {unsizedOf(d) > 0 && <span data-testid={`day-unsized-${d.date}`}>{` · ${unsizedOf(d)} not sized`}</span>}
                    </div>
                    {(d.debriefs_created > 0 || d.learning_events_created > 0) && (
                      <div className="text-[10px] text-muted-foreground">
                        {d.debriefs_created > 0 && `📋${d.debriefs_created} `}
                        {d.learning_events_created > 0 && `🧠${d.learning_events_created}`}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>}

      {selectedDate && mode.isSuccess && (
        <Card data-testid="day-detail-card">
          <CardHeader><CardTitle className="flex items-center gap-2"><CalIcon className="h-4 w-4" /> {selectedDate} — Day Detail</CardTitle></CardHeader>
          <CardContent>
            {day.isLoading ? <Skeleton className="h-32 w-full" /> : day.isError ? (
              <div className="text-sm text-rose-300" data-testid="day-load-error">
                Details for {selectedDate} could not be loaded, so no figures are shown.
              </div>
            ) : day.data ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
                  <div data-testid="day-net-pnl"><div className="text-muted-foreground text-xs">Net P&L</div>{(day.data.day.stats.pnl_not_recorded ?? 0) > 0 ? (
                    <div className="font-bold text-muted-foreground">
                      {day.data.day.stats.pnl_not_recorded >= day.data.day.trades.length ? "Not recorded"
                        : num(day.data.day.stats.net_pnl) == null ? "—" : `${day.data.day.stats.net_pnl.toFixed(2)} (partial)`}
                    </div>
                  ) : num(day.data.day.stats.net_pnl) == null ? <div className="font-bold text-muted-foreground">—</div> : num(day.data.day.stats.total_trades) != null && unsizedOf(day.data.day.stats) >= day.data.day.stats.total_trades ? <div className="font-bold text-muted-foreground" data-testid="day-detail-net-pnl">Not measured</div> : <div className={`font-bold ${day.data.day.stats.net_pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`} data-testid="day-detail-net-pnl">{day.data.day.stats.net_pnl.toFixed(2)}</div>}</div>
                  <div><div className="text-muted-foreground text-xs">Trades</div><div className="font-bold">{num(day.data.day.stats.total_trades) ?? "—"}</div></div>
                  <div><div className="text-muted-foreground text-xs">Win Rate</div><div className="font-bold">{num(day.data.day.stats.win_rate) == null ? "—" : `${day.data.day.stats.win_rate.toFixed(1)}%`}</div></div>
                  <div><div className="text-muted-foreground text-xs">Profit Factor</div><div className="font-bold" data-testid="day-detail-profit-factor">{profitFactorText(day.data.day.stats)}</div></div>
                  <div><div className="text-muted-foreground text-xs">Day Rating</div><div className="font-bold" data-testid="day-detail-rating">{day.data.day.stats.day_rating ?? (num(day.data.day.stats.total_trades) === 0 ? "Not rated — no closed trades" : "Not rated")}</div></div>
                </div>
                {typeof day.data.day.stats.pnl_note === "string" && day.data.day.stats.pnl_note && (
                  <div className="text-xs text-amber-300" data-testid="day-pnl-note">{day.data.day.stats.pnl_note}</div>
                )}
                {dayLiveWithheld && <div className="text-sm text-muted-foreground" data-testid="day-mode-note">{day.data.modeNote ?? "This is a live account. Live trades are not totalled by day here, so no figures are shown. They are not zero."}</div>}
                {(day.data.day.stats.pnl_not_recorded ?? 0) > 0 && (
                  <div className="text-xs text-muted-foreground" data-testid="day-pnl-not-recorded">
                    {day.data.day.stats.pnl_not_recorded} of {day.data.day.trades.length} closed trades on this day have no recorded P&amp;L yet,
                    {day.data.day.stats.pnl_not_recorded >= day.data.day.trades.length
                      ? " so there is no day total or win rate to show."
                      : " so the day total covers only the trades that do and no win rate is shown."}
                  </div>
                )}
                {day.data.day.stats.top_lesson && <div className="text-sm italic text-amber-300">📖 {day.data.day.stats.top_lesson}</div>}
                <div className="space-y-2">
                  {day.data.day.trades.length === 0 && !dayLiveWithheld && <div className="text-muted-foreground text-sm">No trades on this day.</div>}
                  {day.data.day.trades.map((t: any) => (
                    <div key={t.trade_id} className="border border-slate-700 rounded p-3 text-sm" data-testid={`trade-row-${t.trade_id}`}>
                      <div className="flex items-center justify-between">
                        <div className="font-semibold">#{t.trade_id} {t.symbol} <Badge variant="outline">{t.action}</Badge> <Badge>{t.status}</Badge></div>
                        {(() => {
                          const pnl = realizedPnl(t);
                          return pnl == null ? (
                            <div className="text-xs text-muted-foreground text-right" data-testid={`trade-pnl-${t.trade_id}`}>{noPnlText(t)}</div>
                          ) : (
                            <div className={`font-bold ${pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`} data-testid={`trade-pnl-${t.trade_id}`}>{pnl.toFixed(2)}</div>
                          );
                        })()}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        decision_id: {t.decision_id ?? "—"} · entry: {t.entry_price} · exit: {t.exit_price ?? "—"} · SL: {t.stop_loss} · TP: {t.take_profit}
                      </div>
                      {t.decision && <div className="text-xs mt-1">AA: {t.decision.action} (conf {t.decision.confidence}, risk {t.decision.risk_score}, window {t.decision.trade_window_status})</div>}
                      {t.debrief && <div className="text-xs mt-1 text-blue-300">BB lesson: {t.debrief.lesson}</div>}
                      {t.learning && <div className="text-xs text-purple-300">CC: {t.learning.lesson}</div>}
                      {t.ai_followed_own_decision === false && <div className="text-xs text-amber-300">⚠️ AI did not follow its own decision</div>}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
