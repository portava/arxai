// Win/Loss Report (Performance Scorecard) — redesigned to the ARX dashboard
// direction. UI/UX pass: the data contract (GET /api/performance/scorecard)
// and every field — headline, per-environment separation, best/worst symbol,
// strategy ranking, mistake distribution — are preserved exactly. No
// fabricated values; honest empty states where data is absent.

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  BarChart3, Trophy, XCircle, TrendingUp, TrendingDown, Sparkles,
  MessageCircle, AlertTriangle, Layers, ChevronRight, Thermometer, Flame,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAssistantName } from "@/lib/assistant-name";
// Basis of the money on this page. Net P/L is stated here in dollars, and the
// assistant's read draws a conclusion from it ("You're net profitable"); a
// DISPUTED ledger-vs-broker verdict has to be visible alongside that.
import { LedgerBasisStrip } from "@/components/money/LedgerBasisStrip";

type Scorecard = {
  environments: Record<string, { trades?: number; wins?: number; losses?: number; winRate?: number; pnl?: number; note?: string; status?: string; source?: string; excludedUnknown?: number }>;
  headline: {
    scope?: string;
    winRate: number;
    wins?: number;
    losses?: number;
    totalPnl: number;
    totalTrades: number;
    decidedTrades?: number;
    undecidedTrades?: number;
  };
  bestSymbol: string | null; worstSymbol: string | null;
  strategyRanking: Array<{ strategy: string; count: number; pnl: number }>;
  mistakeDistribution: Record<string, number>;
  gradeDistribution: Record<string, unknown>;
  dataSource: string; generatedAt: string;
};

type HeatReport = {
  honestEmpty?: boolean;
  message?: string;
  windowDays?: number;
  snapshotCount?: number;
  generatedAt?: string;
  bestWindow?: { symbol: string; grade: string; heatScore: number } | null;
  worstWindow?: { symbol: string; grade: string; heatScore: number } | null;
  cleanestMarket?: { symbol: string; score: number } | null;
  mostDangerousMarket?: { symbol: string; score: number; state: string } | null;
  missedMoveEvents?: Array<{ symbol: string; heatScore: number }>;
  falseHeatEvents?: Array<{ symbol: string; heatState: string }>;
  symbolBreakdown?: Array<{ symbol: string; avgHeat: number; bestGrade: string; count: number }>;
};

// Opens the mounted assistant panel NOW via its real open event.
// (The old body forged a StorageEvent nothing listened to — the button
// silently no-oped. See lib/assistantPanelBus.)
import { openAssistantPanel as openRubyLiveChat } from "@/lib/assistantPanelBus";

function money(n: number): string {
  const s = n >= 0 ? "+" : "-";
  return `${s}$${Math.abs(n).toFixed(2)}`;
}
// Humanize raw mistake keys (e.g. CHASED_ENTRY → Chased entry).
function humanize(k: string): string {
  return k.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export default function PerformanceScorecard() {
  const [, navigate] = useLocation();
  const { name } = useAssistantName();
  const [s, setS] = useState<Scorecard | null>(null);
  const [err, setErr] = useState("");
  const [heatReport, setHeatReport] = useState<HeatReport | null>(null);

  useEffect(() => {
    fetch("/api/performance/scorecard")
      .then((r) => r.json())
      .then((d) => d.error ? setErr(d.error) : setS(d))
      .catch((e) => setErr(String(e)));
    // Heat learning report — fail-soft (never shown when unavailable)
    fetch("/api/me/heat/learning-report", { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => d && setHeatReport(d))
      .catch(() => undefined);
  }, []);

  // Headline wins/losses come from the server's declared headline scope
  // (the paper journal). They are NEVER summed across the environment rows —
  // that would add journal counts to executed DEMO and LIVE counts under a
  // heading that promises environments are not mixed.
  const totals = { wins: s?.headline.wins ?? 0, losses: s?.headline.losses ?? 0 };
  // Entries with no P/L, and WAIT observations, are not wins or losses. The
  // denominator is shown so `wins + losses < trades` is explained rather
  // than looking like a gap.
  const decided = s?.headline.decidedTrades ?? s?.headline.totalTrades ?? 0;
  const undecided = s?.headline.undecidedTrades ?? 0;
  const headlineScope = (s?.headline.scope ?? "PAPER_JOURNAL").replace(/_/g, " ").toLowerCase();

  const pnlTone = (n: number) => (n > 0 ? "text-success" : n < 0 ? "text-danger" : "text-txt-secondary");

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-4 pb-32 md:pb-6">
      {/* Hero */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/25">
            <BarChart3 className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Win/Loss Report</h1>
            <p className="text-sm text-txt-secondary">Review closed trades, patterns, mistakes, and {name}’s lessons.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={openRubyLiveChat} className="inline-flex items-center gap-2 rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-2 text-sm font-medium text-ruby hover:bg-ruby/15">
            <MessageCircle className="h-4 w-4" /> Ask {name}
          </button>
        </div>
      </div>

      {/* Basis of every dollar figure below: reconciled against the broker, or not. */}
      <LedgerBasisStrip />

      {err && <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{err}</p>}
      {!s && !err && <p className="text-sm text-txt-muted">Loading report…</p>}

      {s && (
        <>
          {/* Summary strip */}
          <div className="text-sm text-txt-secondary">
            {s.headline.totalTrades === 0 ? "No journal entries yet." : (
              <>
                <span className="text-foreground font-medium">{s.headline.totalTrades}</span> Entries ·{" "}
                <span className="text-foreground font-medium">{decided}</span> decided ·{" "}
                <span className="text-success font-medium">{totals.wins}</span> Wins ·{" "}
                <span className="text-danger font-medium">{totals.losses}</span> Losses ·{" "}
                Net P/L <span className={cn("font-semibold", pnlTone(s.headline.totalPnl))}>{money(s.headline.totalPnl)}</span>
              </>
            )}
          </div>
          <p className="-mt-2 text-xs text-txt-muted">
            Basis: {headlineScope} — self-reported, not broker-confirmed.
            {undecided > 0 ? ` ${undecided} entr${undecided === 1 ? "y" : "ies"} with no P/L (or logged as WAIT) are excluded from win rate.` : ""}
          </p>

          {/* Performance summary cards */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            <MetricCard label="Net P/L (journal)" value={money(s.headline.totalPnl)} tone={pnlTone(s.headline.totalPnl)} />
            <MetricCard label={`Win Rate (of ${decided})`} value={decided === 0 ? "—" : `${s.headline.winRate}%`} tone="text-foreground" />
            <MetricCard label="Wins" value={String(totals.wins)} tone="text-success" icon={<Trophy className="h-4 w-4 text-success" />} />
            <MetricCard label="Losses" value={String(totals.losses)} tone="text-danger" icon={<XCircle className="h-4 w-4 text-danger" />} />
            <MetricCard label="Entries" value={String(s.headline.totalTrades)} tone="text-foreground" />
          </div>

          {/* Ruby read + best/worst */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-ruby/25 bg-card p-4">
              <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-ruby" /><h3 className="text-sm font-semibold text-ruby">{name}’s Performance Read</h3></div>
              {s.headline.totalTrades === 0 ? (
                <p className="mt-2 text-sm text-txt-muted">{name} will generate a performance read after more closed trades are available.</p>
              ) : (
                <p className="mt-2 text-sm text-txt-secondary">
                  {decided === 0
                    ? "No journal entry has a recorded P/L yet, so there is no profitability read."
                    : s.headline.totalPnl >= 0
                      ? "You’re net profitable across your journalled trades."
                      : "You’re net negative across your journalled trades."}{" "}
                  {decided > 0 ? <>Win rate is {s.headline.winRate}% of {decided} decided {decided === 1 ? "entry" : "entries"}.{" "}</> : null}
                  {s.bestSymbol ? <>Your strongest symbol is <span className="text-success font-medium">{s.bestSymbol}</span>.</> : null}{" "}
                  {s.worstSymbol ? <>Watch <span className="text-danger font-medium">{s.worstSymbol}</span> — it’s been your weakest.</> : null}
                </p>
              )}
              <button onClick={openRubyLiveChat} className="mt-3 flex w-full items-center justify-between rounded-lg border border-ruby/40 bg-ruby/10 px-3 py-2 text-sm font-medium text-ruby">
                <span className="inline-flex items-center gap-1.5"><MessageCircle className="h-4 w-4" /> Ask {name}</span>
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center gap-2"><TrendingUp className="h-4 w-4 text-success" /><h3 className="text-sm font-semibold">Best Symbol</h3></div>
                <p className="mt-2 font-mono text-2xl font-bold">{s.bestSymbol ?? "—"}</p>
                {!s.bestSymbol && <p className="text-xs text-txt-muted">Best symbol will appear after winning trades are recorded.</p>}
              </div>
              <div className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center gap-2"><TrendingDown className="h-4 w-4 text-danger" /><h3 className="text-sm font-semibold">Worst Symbol</h3></div>
                <p className="mt-2 font-mono text-2xl font-bold">{s.worstSymbol ?? "—"}</p>
                {!s.worstSymbol && <p className="text-xs text-txt-muted">Worst symbol will appear after losing trades are recorded.</p>}
              </div>
            </div>
          </div>

          {/* Environment separation (preserved — never mixed) */}
          <div className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center gap-2"><Layers className="h-4 w-4 text-primary" /><h3 className="text-sm font-semibold">Environment Separation</h3></div>
            <p className="mt-0.5 text-xs text-txt-muted">
              Results are never mixed across environments, and never summed into one figure.
              Each row states the source it was derived from.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-txt-muted">
                    <th className="py-2 pr-3 font-medium">Environment</th>
                    <th className="py-2 pr-3 font-medium">Source</th>
                    <th className="py-2 pr-3 font-medium">Trades</th>
                    <th className="py-2 pr-3 font-medium">Win Rate</th>
                    <th className="py-2 pr-3 font-medium text-right">P/L</th>
                    <th className="py-2 pr-3 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(s.environments).map(([envName, v]) => (
                    <tr key={envName} className="border-b border-border/50 last:border-0">
                      <td className="py-2.5 pr-3 font-mono text-xs">{envName}</td>
                      <td className="py-2.5 pr-3 font-mono text-[11px] text-txt-muted">{v.source ?? "—"}</td>
                      <td className="py-2.5 pr-3">{v.trades ?? 0}</td>
                      <td className="py-2.5 pr-3">{(v.trades ?? 0) === 0 ? "—" : v.winRate != null ? `${v.winRate}%` : "—"}</td>
                      <td className={cn("py-2.5 pr-3 text-right font-mono", v.pnl != null ? pnlTone(v.pnl) : "text-txt-muted")}>{(v.trades ?? 0) === 0 ? "—" : v.pnl != null ? money(v.pnl) : "—"}</td>
                      <td className="py-2.5 pr-3 text-txt-muted">{v.status ?? v.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Strategy ranking + mistake patterns */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-center gap-2"><Trophy className="h-4 w-4 text-warning" /><h3 className="text-sm font-semibold">Strategy Ranking</h3></div>
              <div className="mt-3">
                {s.strategyRanking.length === 0 ? (
                  <p className="text-xs text-txt-muted">No strategy data yet. Rankings appear once trades are journaled.</p>
                ) : (
                  <ol className="space-y-1.5 text-sm">
                    {s.strategyRanking.map((r, i) => (
                      <li key={r.strategy} className="flex items-center justify-between border-b border-border/50 py-1.5 last:border-0">
                        <span className="text-txt-secondary">{i + 1}. {r.strategy} <span className="text-txt-muted">({r.count})</span></span>
                        <span className={cn("font-mono", pnlTone(r.pnl))}>{money(r.pnl)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-warning" /><h3 className="text-sm font-semibold">Mistake Patterns</h3></div>
              <div className="mt-3">
                {Object.keys(s.mistakeDistribution).length === 0 ? (
                  <p className="text-xs text-txt-muted">No mistakes logged yet. Mistake patterns appear after trades are reviewed.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {Object.entries(s.mistakeDistribution).map(([k, v]) => (
                      <li key={k} className="flex items-center justify-between border-b border-border/50 py-1.5 last:border-0">
                        <span className="text-txt-secondary">{humanize(k)}</span>
                        <span className="rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 font-mono text-xs text-warning">{v}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>

          {/* Heat Intelligence — shown only when real data exists */}
          {heatReport && !heatReport.honestEmpty && (
            <div className="rounded-2xl border border-warning/20 bg-card p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Thermometer className="h-4 w-4 text-warning" />
                  <h3 className="text-sm font-semibold">Heat Intelligence (Last {heatReport.windowDays ?? 1}d)</h3>
                </div>
                <button onClick={() => navigate("/market-heat-map")} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                  <ChevronRight className="h-3.5 w-3.5" /> View heat map
                </button>
              </div>
              <p className="mt-0.5 text-xs text-txt-muted">Based on {heatReport.snapshotCount ?? 0} timing snapshots. Advisory only — never an execution gate.</p>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {heatReport.cleanestMarket && (
                  <div className="rounded-xl border border-border bg-secondary/40 p-2.5">
                    <div className="text-[11px] text-txt-muted">Cleanest Market</div>
                    <div className="mt-1 font-mono text-base font-bold text-success">{heatReport.cleanestMarket.symbol}</div>
                    <div className="text-[11px] text-txt-muted">tradeability {heatReport.cleanestMarket.score}</div>
                  </div>
                )}
                {heatReport.mostDangerousMarket && (
                  <div className="rounded-xl border border-border bg-secondary/40 p-2.5">
                    <div className="text-[11px] text-txt-muted">Most Dangerous</div>
                    <div className="mt-1 font-mono text-base font-bold text-danger">{heatReport.mostDangerousMarket.symbol}</div>
                    <div className="text-[11px] text-txt-muted">{heatReport.mostDangerousMarket.state?.replace(/_/g, " ").toLowerCase()}</div>
                  </div>
                )}
                {heatReport.bestWindow && (
                  <div className="rounded-xl border border-border bg-secondary/40 p-2.5">
                    <div className="text-[11px] text-txt-muted">Best Entry Window</div>
                    <div className="mt-1 font-mono text-base font-bold text-success">{heatReport.bestWindow.symbol}</div>
                    <div className="text-[11px] text-txt-muted">grade {heatReport.bestWindow.grade} · heat {heatReport.bestWindow.heatScore}</div>
                  </div>
                )}
                <div className="rounded-xl border border-border bg-secondary/40 p-2.5">
                  <div className="text-[11px] text-txt-muted">Heat Flags</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Flame className="h-4 w-4 text-warning" />
                    <span className="text-base font-bold">{(heatReport.missedMoveEvents?.length ?? 0) + (heatReport.falseHeatEvents?.length ?? 0)}</span>
                  </div>
                  <div className="text-[11px] text-txt-muted">{heatReport.missedMoveEvents?.length ?? 0} exhausted · {heatReport.falseHeatEvents?.length ?? 0} false heat</div>
                </div>
              </div>
              {(heatReport.symbolBreakdown?.length ?? 0) > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] text-txt-muted mb-1.5">Top symbols by avg heat</div>
                  <div className="flex flex-wrap gap-1.5">
                    {heatReport.symbolBreakdown!.slice(0, 8).map((sym) => (
                      <span key={sym.symbol} className="inline-flex items-center gap-1 rounded border border-border bg-secondary/60 px-2 py-0.5 text-[11px]">
                        <span className="font-mono font-medium">{sym.symbol}</span>
                        <span className="text-txt-muted">·</span>
                        <span className="text-warning">{sym.avgHeat}</span>
                        <span className="text-txt-muted">{sym.bestGrade}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <p className="text-xs text-txt-muted">
            Data source: {s.dataSource} · generated {new Date(s.generatedAt).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}

function MetricCard({ label, value, tone, icon }: { label: string; value: string; tone: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-txt-muted">{label}</span>
        {icon}
      </div>
      <div className={cn("mt-1 text-xl font-bold", tone)}>{value}</div>
    </div>
  );
}
