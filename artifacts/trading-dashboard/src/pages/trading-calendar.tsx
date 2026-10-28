import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  /** "—" = not rated (the live route computes no day rating). */
  day_rating: "A" | "B" | "C" | "D" | "F" | "—";
  day_status: "WINNING_DAY" | "LOSING_DAY" | "BREAK_EVEN_DAY" | "NO_TRADE_DAY";
  debriefs_created: number;
  learning_events_created: number;
  symbols_traded: string[];
}
interface CalendarResp {
  calendar: { month: string; days: CalendarDay[]; total_pnl: number; total_trades: number; winning_days: number; losing_days: number; no_trade_days: number };
  /**
   * The server answered for a LIVE_SHARED account without reading any trades
   * (an empty, mode-tagged reply). Nothing was looked up, so the page must not
   * show it as "no trades" or a 0.00 month.
   */
  notShownHere?: boolean;
}
interface DayDetailResp { day: { date: string; stats: any; trades: any[] } }

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
// computes no day rating, so live days are shown as not rated ("—").
function mapLiveToCalendarResp(
  month: string,
  live: { days?: any[]; isEmpty?: boolean; currentAccountMode?: string } | undefined,
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
    const status: CalendarDay["day_status"] =
      trades === 0 ? "NO_TRADE_DAY" : pnl > 0 ? "WINNING_DAY" : pnl < 0 ? "LOSING_DAY" : "BREAK_EVEN_DAY";
    return {
      date,
      net_pnl: pnl,
      total_trades: trades,
      wins: Number(d.wins ?? 0),
      losses: Number(d.losses ?? 0),
      win_rate: Number(d.winRate ?? 0),
      day_rating: "—" as const,
      day_status: status,
      debriefs_created: 0,
      learning_events_created: 0,
      symbols_traded: [],
    };
  });
  return {
    notShownHere: live?.currentAccountMode === "LIVE_SHARED",
    calendar: {
      month,
      days,
      total_pnl: days.reduce((s, d) => s + d.net_pnl, 0),
      total_trades: days.reduce((s, d) => s + d.total_trades, 0),
      winning_days: days.filter((d) => d.day_status === "WINNING_DAY").length,
      losing_days: days.filter((d) => d.day_status === "LOSING_DAY").length,
      no_trade_days: days.filter((d) => d.day_status === "NO_TRADE_DAY").length,
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
  const qc = useQueryClient();
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
  // A failed (re)load is shown as a failure, never over older data.
  const calData = cal.isError ? undefined : cal.data;
  const notShownHere = calData?.notShownHere === true;

  const day = useQuery<DayDetailResp>({
    queryKey: ["trading-calendar-day", selectedDate, isLive],
    enabled: !!selectedDate && mode.isSuccess,
    queryFn: async () => {
      if (isLive) {
        const d = await readJson(`/api/me/performance-calendar/${selectedDate}`, { credentials: "include" });
        if (!Array.isArray(d?.trades)) throw new Error("/api/me/performance-calendar/:date returned no trades");
        // Map live day-agg → DayDetailResp shape the UI renders.
        return {
          day: {
            date: selectedDate!,
            stats: {
              net_pnl: Number(d.totalPnl ?? 0),
              total_trades: Number(d.tradesCount ?? 0),
              win_rate: Number(d.winRate ?? 0),
              profit_factor: "—",
              day_rating: "—",
              top_lesson: null,
            },
            trades: Array.isArray(d.trades) ? d.trades.map((t: any) => ({
              trade_id: t.id, symbol: t.symbol, action: t.side, status: "CLOSED",
              pnl: Number(t.pnl ?? 0), decision_id: null,
              entry_price: t.entryPrice, exit_price: t.exitPrice,
              stop_loss: "—", take_profit: "—",
            })) : [],
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

  const rebuild = useMutation({
    mutationFn: async () => (await fetch("/api/performance/rebuild", { method: "POST" })).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["trading-calendar"] }),
  });

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
              ? "Live trades on your shared account are not shown on this calendar."
              : isLive ? "Daily P&L and win rate from your live trades." : "Daily P&L, win rate, and AI activity from your demo trades."}
          </div>
        </div>
        <div className="flex gap-2">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-sm"
            data-testid="input-month"
          />
          {mode.isSuccess && !isLive && (
            <Button onClick={() => rebuild.mutate()} disabled={rebuild.isPending} data-testid="btn-rebuild">
              <RefreshCcw className={`mr-2 h-4 w-4 ${rebuild.isPending ? "animate-spin" : ""}`} />
              Rebuild
            </Button>
          )}
        </div>
      </div>

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

      {calData && !notShownHere && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Net P&L (month)</CardTitle></CardHeader>
            <CardContent><div className={`text-xl font-bold ${calData.calendar.total_pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{calData.calendar.total_pnl.toFixed(2)}</div></CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Total Trades</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold">{calData.calendar.total_trades}</div></CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Winning Days</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold text-emerald-400">{calData.calendar.winning_days}</div></CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Losing Days</CardTitle></CardHeader>
            <CardContent><div className="text-xl font-bold text-rose-400">{calData.calendar.losing_days}</div></CardContent></Card>
        </div>
      )}

      {isLive && calData && !notShownHere && calData.calendar.total_trades === 0 && (
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
              The calendar for {month} could not be loaded. Nothing is shown rather than an empty month.
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
                      {d.day_rating !== "—" && <Badge variant="outline" className="text-[10px] px-1 py-0">{d.day_rating}</Badge>}
                    </div>
                    <div className="mt-1 text-sm font-bold flex items-center gap-1">
                      {d.day_status === "WINNING_DAY" && <TrendingUp className="h-3 w-3" />}
                      {d.day_status === "LOSING_DAY" && <TrendingDown className="h-3 w-3" />}
                      {d.day_status === "BREAK_EVEN_DAY" && <Minus className="h-3 w-3" />}
                      {d.total_trades > 0 ? d.net_pnl.toFixed(2) : "—"}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {d.total_trades > 0 ? `${d.total_trades}t · ${d.win_rate.toFixed(0)}%w` : "no trades"}
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

      {selectedDate && (
        <Card data-testid="day-detail-card">
          <CardHeader><CardTitle className="flex items-center gap-2"><CalIcon className="h-4 w-4" /> {selectedDate} — Day Detail</CardTitle></CardHeader>
          <CardContent>
            {day.isLoading ? <Skeleton className="h-32 w-full" /> : day.isError ? (
              <div className="text-sm text-rose-300" data-testid="day-load-error">
                Details for {selectedDate} could not be loaded.
              </div>
            ) : day.data ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
                  <div><div className="text-muted-foreground text-xs">Net P&L</div><div className={`font-bold ${day.data.day.stats.net_pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{day.data.day.stats.net_pnl.toFixed(2)}</div></div>
                  <div><div className="text-muted-foreground text-xs">Trades</div><div className="font-bold">{day.data.day.stats.total_trades}</div></div>
                  <div><div className="text-muted-foreground text-xs">Win Rate</div><div className="font-bold">{day.data.day.stats.win_rate.toFixed(1)}%</div></div>
                  <div><div className="text-muted-foreground text-xs">Profit Factor</div><div className="font-bold">{day.data.day.stats.profit_factor}</div></div>
                  <div><div className="text-muted-foreground text-xs">Day Rating</div><div className="font-bold">{day.data.day.stats.day_rating}</div></div>
                </div>
                {day.data.day.stats.top_lesson && <div className="text-sm italic text-amber-300">📖 {day.data.day.stats.top_lesson}</div>}
                <div className="space-y-2">
                  {day.data.day.trades.length === 0 && <div className="text-muted-foreground text-sm">No trades on this day.</div>}
                  {day.data.day.trades.map((t: any) => (
                    <div key={t.trade_id} className="border border-slate-700 rounded p-3 text-sm" data-testid={`trade-row-${t.trade_id}`}>
                      <div className="flex items-center justify-between">
                        <div className="font-semibold">#{t.trade_id} {t.symbol} <Badge variant="outline">{t.action}</Badge> <Badge>{t.status}</Badge></div>
                        <div className={`font-bold ${t.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{t.pnl.toFixed(2)}</div>
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
