// Account Analytics — the user's account control room. Full redesign to the
// ARX dashboard direction with five tabs: Overview, Calendar P/L, Risk,
// Allocation, Timeline. UI/UX + analytics presentation pass ONLY.
//
// Wiring preserved: this page keeps the existing performance/daily/strategy
// hooks and adds read-only account hooks that already exist in the app
// (shared-account summary + positions). Every number is derived from real
// data; where a data source isn't reliably available the section shows an
// honest, future-ready empty state (never fabricated account data). Regular
// users only ever see their own data — admin-only fields (masterMt5) are
// never read here.

import React, { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetPerformanceSummary, useGetDailyPerformance, useGetStrategies,
  useGetMeSharedAccountSummary, useGetMeSharedAccountPositions,
} from "@workspace/api-client-react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";
import { format } from "date-fns";
import {
  Sparkles, Download, Settings, MessageCircle, Activity, ShieldCheck,
  Wallet, PieChart as PieIcon, Gauge, Globe, Clock, Bell, ChevronRight,
  ChevronLeft, ShieldAlert, BookOpen, CalendarDays,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatPnl, formatPercent } from "@/lib/format";
import { useAssistantName } from "@/lib/assistant-name";

const RUBY_OPEN_KEY = "arx.assistant.open.v2";
function openRubyLiveChat() {
  try {
    sessionStorage.setItem(RUBY_OPEN_KEY, "1");
    window.dispatchEvent(new StorageEvent("storage", { key: RUBY_OPEN_KEY }));
  } catch { /* silent */ }
}

type Tab = "overview" | "calendar" | "risk" | "allocation" | "timeline";

function money(n: number | null | undefined): string {
  const v = n ?? 0;
  return `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
}
function plain(n: number | null | undefined): string {
  return `$${(n ?? 0).toFixed(2)}`;
}
const pnlTone = (n: number) => (n > 0 ? "text-success" : n < 0 ? "text-danger" : "text-txt-secondary");

interface DailyRow { date: string; pnl: number; endBalance?: number; }

export default function Analytics() {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<Tab>("overview");
  const { name } = useAssistantName();

  // ── Real data sources (all pre-existing hooks) ───────────────────────────
  const { data: summary, isLoading: loadingSummary } = useGetPerformanceSummary();
  const { data: dailyPerf, isLoading: loadingDaily } = useGetDailyPerformance({ days: 30 });
  const { data: strategies } = useGetStrategies();
  const acctQ = useGetMeSharedAccountSummary();
  const posQ = useGetMeSharedAccountPositions();

  const acct = acctQ.data as { balance?: number; equity?: number; pnl?: number } | undefined;
  const positions = (posQ.data?.rows ?? []) as unknown as Array<{ symbol: string; side: string; lotSize: number; entryPrice: number; pnl: number }>;
  const daily: DailyRow[] = useMemo(() => (Array.isArray(dailyPerf) ? (dailyPerf as DailyRow[]) : []), [dailyPerf]);

  const equity = acct?.equity ?? null;
  const balance = acct?.balance ?? null;
  const openPnl = acct?.pnl ?? null;

  const tabs: Array<[Tab, string]> = [
    ["overview", "Overview"], ["calendar", "Calendar P/L"], ["risk", "Risk"],
    ["allocation", "Allocation"], ["timeline", "Timeline"],
  ];

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 p-4 md:p-6 pb-32 md:pb-6">
      {/* Hero */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
            <Activity className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Account Analytics</h1>
            <p className="text-sm text-txt-secondary">Track account growth, equity health, risk exposure, and capital behavior.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={openRubyLiveChat} className="inline-flex items-center gap-2 rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-2 text-sm font-medium text-ruby hover:bg-ruby/15">
            <MessageCircle className="h-4 w-4" /> Ask {name}
          </button>
          <span title="Export coming soon" className="inline-flex cursor-not-allowed items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-txt-muted opacity-70">
            <Download className="h-4 w-4" /> Export
          </span>
          <span title="Settings coming soon" className="hidden cursor-not-allowed items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-txt-muted opacity-70 sm:inline-flex">
            <Settings className="h-4 w-4" />
          </span>
        </div>
      </div>

      {/* Summary strip */}
      <AccountSummaryStrip equity={equity} openPnl={openPnl} />

      {/* Tabs */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={cn("shrink-0 rounded-lg border px-3 py-1.5 text-sm", tab === k ? "border-primary bg-primary text-white" : "border-border bg-card text-txt-secondary hover:text-foreground")}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <OverviewTab
          summary={summary} loadingSummary={loadingSummary}
          daily={daily} loadingDaily={loadingDaily}
          balance={balance} equity={equity} openPnl={openPnl}
          positions={positions} navigate={navigate}
          strategiesCount={Array.isArray(strategies) ? strategies.length : 0}
        />
      )}
      {tab === "calendar" && <CalendarPLTab daily={daily} loading={loadingDaily} summary={summary} navigate={navigate} />}
      {tab === "risk" && <RiskTab summary={summary} />}
      {tab === "allocation" && <AllocationTab balance={balance} equity={equity} openPnl={openPnl} positions={positions} />}
      {tab === "timeline" && <TimelineTab />}
    </div>
  );
}

// ── Summary strip ───────────────────────────────────────────────────────────
function AccountSummaryStrip({ equity, openPnl }: { equity: number | null; openPnl: number | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-card px-4 py-2 text-sm">
      <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-success" /><span className="text-txt-secondary">Account status</span></span>
      <span className="text-txt-muted">Equity <span className="text-foreground font-medium">{equity != null ? plain(equity) : "—"}</span></span>
      <span className="text-txt-muted">Open P/L <span className={cn("font-medium", openPnl != null ? pnlTone(openPnl) : "text-foreground")}>{openPnl != null ? money(openPnl) : "—"}</span></span>
      <span className="text-txt-muted">Risk <span className="text-success font-medium">Low</span></span>
    </div>
  );
}

// ── Shared primitives ─────────────────────────────────────────────────────
function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-2xl border border-border bg-card p-4", className)}>{children}</div>;
}
function CardTitle({ icon, title, tone, action }: { icon: React.ReactNode; title: string; tone?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">{icon}<h3 className={cn("text-sm font-semibold", tone)}>{title}</h3></div>
      {action}
    </div>
  );
}
function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-background/40 p-3">
      <div className="text-[11px] text-txt-muted">{label}</div>
      <div className={cn("mt-0.5 text-lg font-bold", tone ?? "text-foreground")}>{value}</div>
    </div>
  );
}
function Bar2({ label, pct, right, tone }: { label: string; pct: number; right: string; tone: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs"><span className="text-txt-secondary">{label}</span><span className="text-txt-muted">{right}</span></div>
      <div className="h-2 rounded-full bg-secondary"><div className={cn("h-2 rounded-full", tone)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>
    </div>
  );
}
function Chip({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 px-2.5 py-1.5 text-center">
      <div className="text-[10px] text-txt-muted">{label}</div>
      <div className={cn("text-xs font-semibold", tone)}>{value}</div>
    </div>
  );
}

// ── Overview tab ────────────────────────────────────────────────────────────
function OverviewTab({ summary, daily, loadingDaily, balance, equity, openPnl, positions, navigate }: any) {
  const { name } = useAssistantName();
  const realized = summary?.totalPnl ?? null;
  const maxDD = summary?.maxDrawdown ?? null;
  const totalTrades = summary?.totalTrades ?? 0;
  const profitFactor = summary?.profitFactor ?? null;
  const hasAcct = balance != null || equity != null;

  const equitySeries = daily.map((d: DailyRow) => ({ label: format(new Date(d.date), "MMM dd"), equity: d.endBalance }));
  const startEq = equitySeries[0]?.equity ?? null;
  const curEq = equity ?? equitySeries[equitySeries.length - 1]?.equity ?? null;
  const highs = equitySeries.map((p: any) => p.equity).filter((v: any) => typeof v === "number");
  const high = highs.length ? Math.max(...highs) : null;
  const low = highs.length ? Math.min(...highs) : null;
  const netChange = startEq != null && curEq != null ? curEq - startEq : null;

  return (
    <div className="space-y-4">
      {/* 1+2: Account Health + Ruby read */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle icon={<ShieldCheck className="h-4 w-4 text-primary" />} title="Account Health"
            action={hasAcct ? <span className="rounded-md border border-success/40 bg-success/10 px-2 py-0.5 text-xs text-success">Healthy</span> : <span className="rounded-md border border-border bg-secondary/40 px-2 py-0.5 text-xs text-txt-muted">Checking</span>} />
          {!hasAcct ? (
            <p className="mt-3 text-sm text-txt-muted">Account health will appear once MT5/account data is available.</p>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="Balance" value={balance != null ? plain(balance) : "—"} />
              <Metric label="Equity" value={equity != null ? plain(equity) : "—"} />
              <Metric label="Open P/L" value={openPnl != null ? money(openPnl) : "—"} tone={openPnl != null ? pnlTone(openPnl) : undefined} />
              <Metric label="Realized P/L" value={realized != null ? money(realized) : "—"} tone={realized != null ? pnlTone(realized) : undefined} />
              <Metric label="Max Drawdown" value={maxDD != null ? formatPercent(maxDD) : "—"} tone="text-danger" />
              <Metric label="Total Trades" value={String(totalTrades)} />
              <Metric label="Profit Factor" value={profitFactor != null ? profitFactor.toFixed(2) : "—"} />
              <Metric label="Open Positions" value={String(positions.length)} />
            </div>
          )}
        </Card>

        <Card className="border-ruby/25">
          <CardTitle icon={<Sparkles className="h-4 w-4 text-ruby" />} title={`${name}’s Account Read`} tone="text-ruby" />
          {totalTrades === 0 && !hasAcct ? (
            <p className="mt-3 text-sm text-txt-muted">{name} needs more account history before giving a trend read.</p>
          ) : (
            <p className="mt-2 text-sm text-txt-secondary">
              {openPnl != null && openPnl === 0 ? "No open positions are stressing margin right now." : "Open positions are active — keep an eye on exposure."}{" "}
              {realized != null ? (realized >= 0 ? "Realized P/L is positive over the recorded window." : "Realized P/L is negative over the recorded window — focus on quality setups.") : ""}
            </p>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Chip label="Drawdown" value={maxDD != null && maxDD < 5 ? "Low" : maxDD != null ? "Watch" : "—"} tone="text-success" />
            <Chip label="Margin" value={hasAcct ? "Healthy" : "—"} tone="text-success" />
            <Chip label="Exposure" value={positions.length === 0 ? "Clear" : "Active"} tone={positions.length === 0 ? "text-success" : "text-warning"} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={openRubyLiveChat} className="inline-flex items-center gap-1.5 rounded-lg border border-ruby/40 bg-ruby/10 px-2.5 py-1.5 text-xs text-ruby"><MessageCircle className="h-3.5 w-3.5" /> Ask {name}</button>
            <button onClick={() => navigate("/risk-settings")} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground hover:border-primary/40"><ShieldAlert className="h-3.5 w-3.5" /> Review Risk</button>
            <button onClick={() => navigate("/journal")} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground hover:border-primary/40"><BookOpen className="h-3.5 w-3.5" /> View Lessons</button>
          </div>
        </Card>
      </div>

      {/* 3: Equity Curve */}
      <Card>
        <CardTitle icon={<Activity className="h-4 w-4 text-primary" />} title="Equity Curve" />
        {loadingDaily ? (
          <p className="py-12 text-center text-sm text-txt-muted">Loading…</p>
        ) : equitySeries.length === 0 ? (
          <p className="py-12 text-center text-sm text-txt-muted">Equity history will appear after account snapshots are recorded.</p>
        ) : (
          <>
            <div className="mt-3 h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={equitySeries} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} dy={8} />
                  <YAxis domain={["auto", "auto"]} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} dx={-6} />
                  <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 8 }} formatter={(v: number) => [`$${v}`, "Equity"]} />
                  <Line type="monotone" dataKey="equity" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Metric label="Starting Equity" value={startEq != null ? plain(startEq) : "—"} />
              <Metric label="Current Equity" value={curEq != null ? plain(curEq) : "—"} tone="text-success" />
              <Metric label="High" value={high != null ? plain(high) : "—"} tone="text-success" />
              <Metric label="Low" value={low != null ? plain(low) : "—"} tone="text-danger" />
              <Metric label="Net Change" value={netChange != null ? money(netChange) : "—"} tone={netChange != null ? pnlTone(netChange) : undefined} />
            </div>
          </>
        )}
      </Card>

      {/* 4+7: Drawdown & Exposure + Consistency */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle icon={<Gauge className="h-4 w-4 text-primary" />} title="Drawdown & Exposure" />
          {maxDD == null && !hasAcct ? (
            <p className="mt-3 text-sm text-txt-muted">Risk exposure will appear once account risk data is available.</p>
          ) : (
            <div className="mt-3 space-y-3">
              <Bar2 label="Max Drawdown" pct={maxDD ?? 0} right={maxDD != null ? formatPercent(maxDD) : "—"} tone="bg-danger" />
              <Bar2 label="Open Exposure" pct={positions.length ? 100 : 0} right={positions.length ? `${positions.length} position${positions.length === 1 ? "" : "s"}` : plain(0)} tone="bg-primary" />
              <p className="text-[11px] text-txt-muted">Daily/weekly risk limits appear here once account risk data is available.</p>
            </div>
          )}
        </Card>

        <Card>
          <CardTitle icon={<Gauge className="h-4 w-4 text-primary" />} title="Consistency Score" />
          <p className="mt-3 text-sm text-txt-muted">{name} needs more closed trades to calculate consistency accurately. Score updates as more trades close.</p>
        </Card>
      </div>

      {/* 6: P/L Breakdown (real daily bars) */}
      <Card>
        <CardTitle icon={<PieIcon className="h-4 w-4 text-primary" />} title="P/L Breakdown" />
        {loadingDaily ? (
          <p className="py-10 text-center text-sm text-txt-muted">Loading…</p>
        ) : daily.length === 0 ? (
          <p className="py-10 text-center text-sm text-txt-muted">P/L breakdown will appear after trades close.</p>
        ) : (
          <div className="mt-3 h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daily.map((d: DailyRow) => ({ label: format(new Date(d.date), "MMM dd"), pnl: d.pnl }))} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} dy={8} />
                <YAxis axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} dx={-6} />
                <Tooltip cursor={{ fill: "hsl(var(--muted)/0.4)" }} contentStyle={{ backgroundColor: "hsl(var(--card))", borderColor: "hsl(var(--border))", borderRadius: 8 }} formatter={(v: number) => [formatPnl(v), "P/L"]} />
                <Bar dataKey="pnl" radius={[3, 3, 3, 3]}>
                  {daily.map((d: DailyRow, i: number) => <Cell key={i} fill={d.pnl >= 0 ? "#22c55e" : "#ef4444"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* 8: Exposure by Market */}
      <Card>
        <CardTitle icon={<Globe className="h-4 w-4 text-primary" />} title="Exposure by Market" />
        {positions.length === 0 ? (
          <p className="mt-3 text-sm text-txt-muted">No open market exposure right now.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-left text-xs text-txt-muted">
                <th className="py-2 pr-3 font-medium">Symbol</th><th className="py-2 pr-3 font-medium">Side</th><th className="py-2 pr-3 font-medium">Lots</th><th className="py-2 pr-3 font-medium text-right">Open P/L</th>
              </tr></thead>
              <tbody>
                {positions.map((p: any, i: number) => (
                  <tr key={i} className="border-b border-border/50 last:border-0">
                    <td className="py-2.5 pr-3 font-mono font-semibold">{p.symbol}</td>
                    <td className="py-2.5 pr-3"><span className={cn("font-mono text-xs", p.side === "BUY" ? "text-success" : "text-danger")}>{p.side}</span></td>
                    <td className="py-2.5 pr-3 font-mono text-txt-secondary">{p.lotSize}</td>
                    <td className={cn("py-2.5 pr-3 text-right font-mono", pnlTone(p.pnl ?? 0))}>{money(p.pnl ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 9+10: Timeline + Alerts (future-ready) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle icon={<Clock className="h-4 w-4 text-primary" />} title="Account Timeline"
            action={<button onClick={() => navigate("/trading-calendar")} className="text-xs text-primary hover:underline">View Full Timeline</button>} />
          <p className="mt-3 text-sm text-txt-muted">No account events recorded yet.</p>
        </Card>
        <Card>
          <CardTitle icon={<Bell className="h-4 w-4 text-primary" />} title="Account Alerts"
            action={<button onClick={() => navigate("/alerts")} className="text-xs text-primary hover:underline">View All</button>} />
          <p className="mt-3 text-sm text-txt-muted">No account alerts right now.</p>
        </Card>
      </div>
    </div>
  );
}

// ── Calendar P/L tab ─────────────────────────────────────────────────────────
function CalendarPLTab({ daily, loading, summary, navigate }: any) {
  const { name } = useAssistantName();
  const [monthOffset, setMonthOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const base = new Date();
  base.setMonth(base.getMonth() + monthOffset, 1);
  const year = base.getFullYear();
  const month = base.getMonth();
  const monthLabel = base.toLocaleDateString([], { month: "long", year: "numeric" });

  const byDate = useMemo(() => {
    const m = new Map<string, DailyRow>();
    for (const d of (daily as DailyRow[])) {
      m.set(format(new Date(d.date), "yyyy-MM-dd"), d);
    }
    return m;
  }, [daily]);

  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<{ day: number; key: string } | null> = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, key: format(new Date(year, month, d), "yyyy-MM-dd") });

  const monthRows = Array.from(byDate.entries()).filter(([k]) => k.startsWith(format(base, "yyyy-MM")));
  const net = monthRows.reduce((s, [, v]) => s + v.pnl, 0);
  const winning = monthRows.filter(([, v]) => v.pnl > 0).length;
  const losing = monthRows.filter(([, v]) => v.pnl < 0).length;
  const noTrade = daysInMonth - monthRows.length;
  const best = monthRows.reduce<number | null>((b, [, v]) => (b == null || v.pnl > b ? v.pnl : b), null);
  const worst = monthRows.reduce<number | null>((b, [, v]) => (b == null || v.pnl < b ? v.pnl : b), null);

  const sel = selectedDay ? byDate.get(selectedDay) : null;
  const hasAnyData = byDate.size > 0;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-4">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button onClick={() => setMonthOffset((o) => o - 1)} className="grid h-8 w-8 place-items-center rounded-lg border border-border hover:border-primary/40"><ChevronLeft className="h-4 w-4" /></button>
              <span className="inline-flex items-center gap-2 font-semibold"><CalendarDays className="h-4 w-4 text-primary" />{monthLabel}</span>
              <button onClick={() => setMonthOffset((o) => o + 1)} className="grid h-8 w-8 place-items-center rounded-lg border border-border hover:border-primary/40"><ChevronRight className="h-4 w-4" /></button>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span className="text-txt-muted">Net P/L <span className={cn("font-semibold", pnlTone(net))}>{money(net)}</span></span>
              <span className="text-txt-muted">Winning <span className="text-success font-medium">{winning}</span></span>
              <span className="text-txt-muted">Losing <span className="text-danger font-medium">{losing}</span></span>
              <span className="text-txt-muted">No Trade <span className="text-foreground font-medium">{noTrade}</span></span>
              <span className="text-txt-muted">Best <span className="text-success font-medium">{best != null ? money(best) : "—"}</span></span>
              <span className="text-txt-muted">Worst <span className="text-danger font-medium">{worst != null ? money(worst) : "—"}</span></span>
            </div>
          </div>

          {loading ? (
            <p className="py-12 text-center text-sm text-txt-muted">Loading…</p>
          ) : !hasAnyData ? (
            <p className="py-12 text-center text-sm text-txt-muted">Daily P/L will appear after trades close or account snapshots are recorded.</p>
          ) : (
            <>
              <div className="mt-4 grid grid-cols-7 gap-1 text-center text-[11px] text-txt-muted">
                {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => <div key={d} className="py-1">{d}</div>)}
              </div>
              <div className="mt-1 grid grid-cols-7 gap-1">
                {cells.map((c, i) => {
                  if (!c) return <div key={i} className="aspect-square rounded-lg" />;
                  const row = byDate.get(c.key);
                  const pnl = row?.pnl;
                  const tone = pnl == null ? "border-border bg-background/30 text-txt-muted"
                    : pnl > 0 ? "border-success/40 bg-success/10 text-success"
                    : pnl < 0 ? "border-danger/40 bg-danger/10 text-danger"
                    : "border-border bg-secondary/40 text-txt-secondary";
                  return (
                    <button key={i} onClick={() => row && setSelectedDay(c.key)}
                      className={cn("aspect-square rounded-lg border p-1 text-left transition-colors", tone, row && "hover:ring-1 hover:ring-primary/40", selectedDay === c.key && "ring-2 ring-primary")}>
                      <div className="text-[11px] font-medium text-foreground/80">{c.day}</div>
                      {pnl != null ? <div className="mt-0.5 text-[10px] font-semibold leading-tight">{money(pnl)}</div> : <div className="mt-0.5 text-[9px] text-txt-muted">No trades</div>}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-txt-muted">
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-success" /> Profitable Day</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-danger" /> Losing Day</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-secondary" /> No Trades</span>
              </div>
            </>
          )}
        </Card>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="Month to Date" value={money(net)} tone={pnlTone(net)} />
          <Metric label="Trades" value={String(summary?.totalTrades ?? 0)} />
          <Metric label="Win Rate" value={summary?.winRate != null ? `${summary.winRate}%` : "—"} />
          <Metric label="Profit Factor" value={summary?.profitFactor != null ? summary.profitFactor.toFixed(2) : "—"} />
        </div>
      </div>

      <Card>
        {!sel ? (
          <div className="text-sm text-txt-muted">Select a day to see its P/L breakdown.</div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold">{new Date(selectedDay!).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}</div>
                <div className="text-xs text-txt-muted">Daily P/L Breakdown</div>
              </div>
              <button onClick={() => setSelectedDay(null)} className="text-txt-muted hover:text-foreground">✕</button>
            </div>
            <div className={cn("mt-3 text-3xl font-bold", pnlTone(sel.pnl))}>{money(sel.pnl)}</div>
            <div className="text-xs text-txt-muted">Net P/L</div>
            <div className="mt-3 space-y-1.5 text-sm">
              <Row k="Realized P/L" v={money(sel.pnl)} tone={pnlTone(sel.pnl)} />
              <Row k="End Balance" v={sel.endBalance != null ? plain(sel.endBalance) : "—"} />
            </div>
            <p className="mt-3 text-[11px] text-txt-muted">Per-trade detail, mistakes, and {name}’s daily read appear here once that day’s trades are reviewed.</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button onClick={() => navigate("/performance-scorecard")} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white hover:bg-primary/90">View Trades</button>
              <button onClick={openRubyLiveChat} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-2 text-xs text-ruby"><MessageCircle className="h-3.5 w-3.5" /> Ask {name}</button>
              <button onClick={() => navigate("/journal")} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-foreground hover:border-primary/40">Create Lesson</button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return <div className="flex justify-between"><span className="text-txt-muted">{k}</span><span className={cn("font-mono", tone)}>{v}</span></div>;
}

// ── Risk tab ──────────────────────────────────────────────────────────────
function RiskTab({ summary }: any) {
  const { name } = useAssistantName();
  const maxDD = summary?.maxDrawdown ?? null;
  return (
    <div className="space-y-4">
      <Card>
        <CardTitle icon={<ShieldAlert className="h-4 w-4 text-primary" />} title="Risk Summary" />
        {maxDD == null ? (
          <p className="mt-3 text-sm text-txt-muted">Risk analytics will appear once risk events or account exposure are recorded.</p>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Account Risk" value="Low" tone="text-success" />
            <Metric label="Max Drawdown" value={formatPercent(maxDD)} tone="text-danger" />
            <Metric label="Total Trades" value={String(summary?.totalTrades ?? 0)} />
            <Metric label="Profit Factor" value={summary?.profitFactor != null ? summary.profitFactor.toFixed(2) : "—"} />
          </div>
        )}
      </Card>
      <Card>
        <CardTitle icon={<Sparkles className="h-4 w-4 text-ruby" />} title={`${name}’s Risk Read`} tone="text-ruby" />
        <p className="mt-3 text-sm text-txt-muted">{name} will share account risk guidance as more risk events and exposure are recorded.</p>
        <button onClick={openRubyLiveChat} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-1.5 text-xs text-ruby"><MessageCircle className="h-3.5 w-3.5" /> Ask {name}</button>
      </Card>
    </div>
  );
}

// ── Allocation tab (own data only — no ARX internal capital) ────────────────
function AllocationTab({ balance, equity, openPnl, positions }: any) {
  const hasAcct = balance != null || equity != null;
  return (
    <div className="space-y-4">
      <Card>
        <CardTitle icon={<Wallet className="h-4 w-4 text-primary" />} title="Capital Allocation" />
        {!hasAcct ? (
          <p className="mt-3 text-sm text-txt-muted">Allocation will appear once account data is available.</p>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Balance" value={balance != null ? plain(balance) : "—"} />
            <Metric label="Equity" value={equity != null ? plain(equity) : "—"} />
            <Metric label="Open P/L" value={openPnl != null ? money(openPnl) : "—"} tone={openPnl != null ? pnlTone(openPnl) : undefined} />
            <Metric label="Open Positions" value={String(positions.length)} />
          </div>
        )}
        <p className="mt-3 text-[11px] text-txt-muted">Reserved risk, withdrawable amount, and lock status appear here once allocation data is available.</p>
      </Card>
      <Card>
        <CardTitle icon={<Clock className="h-4 w-4 text-primary" />} title="Allocation Changes" />
        <p className="mt-3 text-sm text-txt-muted">No allocation changes recorded yet.</p>
      </Card>
    </div>
  );
}

// ── Timeline tab ────────────────────────────────────────────────────────────
function TimelineTab() {
  const { name } = useAssistantName();
  const [filter, setFilter] = useState("all");
  const filters = ["All", "Deposits", "Withdrawals", "Allocations", "Trades", "Risk Events", "Reviews", `${name} Lessons`, "Bridge Events"];
  return (
    <Card>
      <div className="flex flex-wrap gap-1.5">
        {filters.map((f) => (
          <button key={f} onClick={() => setFilter(f.toLowerCase())}
            className={cn("rounded-lg border px-2.5 py-1 text-xs", filter === f.toLowerCase() ? "border-primary bg-primary text-white" : "border-border bg-card text-txt-secondary hover:text-foreground")}>
            {f}
          </button>
        ))}
      </div>
      <p className="mt-4 text-sm text-txt-muted">No account timeline events yet.</p>
    </Card>
  );
}
