// Phase 9H — Personal Command Center on Dashboard.
// Consumes /api/me/dashboard/cards, /me/dashboard/intelligence, /me/alerts.
// Polls cards every 10s, intelligence every 20s. No fake data; honors empty states.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, AlertTriangle, Bot, Bell, ShieldCheck, Target, BookOpen, Plug, X } from "lucide-react";

type CardsResp = { cards: Record<string, any>; isFirstTime: boolean; liveLocked: boolean; safetyMode: string };
type IntelResp = any;
type AlertsResp = { alerts: any[]; unread: number; isEmpty: boolean };

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return (await r.json()) as T;
}

function StatusDot({ tone }: { tone: "ok" | "warn" | "bad" | "muted" }) {
  const c = tone === "ok" ? "bg-emerald-500" : tone === "warn" ? "bg-amber-500" : tone === "bad" ? "bg-rose-500" : "bg-zinc-500";
  return <span className={`inline-block w-2 h-2 rounded-full ${c}`} />;
}

function EmptyHint({ hint, cta, to }: { hint: string; cta?: string; to?: string }) {
  return (
    <div className="text-xs text-zinc-400">
      {hint}
      {cta && to && <Link href={to} className="ml-2 text-blue-400 hover:underline">{cta} →</Link>}
    </div>
  );
}

export function CommandCenterCards() {
  const qc = useQueryClient();
  const cards = useQuery({ queryKey: ["me", "dashboard", "cards"], queryFn: () => getJSON<CardsResp>("/api/me/dashboard/cards"), refetchInterval: 10_000 });
  const intel = useQuery({ queryKey: ["me", "dashboard", "intelligence"], queryFn: () => getJSON<IntelResp>("/api/me/dashboard/intelligence"), refetchInterval: 20_000 });
  const alerts = useQuery({ queryKey: ["me", "alerts"], queryFn: () => getJSON<AlertsResp>("/api/me/alerts"), refetchInterval: 15_000 });
  const dismiss = useMutation({
    mutationFn: (id: number) => fetch(`/api/me/alerts/${id}/dismiss`, { method: "POST", credentials: "include" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "alerts"] }),
  });

  const c = cards.data?.cards;
  const isFirstTime = cards.data?.isFirstTime;
  const recommendedAction: string | undefined = intel.data?.recommendedNextAction;

  if (cards.isLoading) {
    return <div className="text-xs text-zinc-500" data-testid="cc-loading">Loading your command center…</div>;
  }
  if (cards.isError || !c) {
    return <div className="text-xs text-amber-400" data-testid="cc-error">Couldn't load your command center. Retrying…</div>;
  }

  // Live status is server-authoritative. `liveLocked=true` (or any
  // safetyMode that isn't explicitly "live") means we are NOT armed for
  // live trading and the badge must reflect that — never hard-code
  // "LIVE TRADING ARMED" as a static label.
  const isLiveArmed = cards.data?.liveLocked === false && cards.data?.safetyMode === "live";
  const safetyBadgeLabel = isLiveArmed ? "Live trading" : "Demo trading";
  const safetyBadgeCls = isLiveArmed
    ? "border-emerald-500/50 text-emerald-300"
    : "border-zinc-700 text-zinc-300";

  return (
    <div className="space-y-4" data-testid="command-center">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100" data-testid="cc-header">Command Center</h2>
          {recommendedAction && (
            <div className="text-xs text-zinc-400 mt-0.5" data-testid="cc-next-action">Next: {recommendedAction}</div>
          )}
        </div>
        <Badge variant="outline" className={`text-[10px] ${safetyBadgeCls}`} data-testid="cc-safety-badge">
          {safetyBadgeLabel}
        </Badge>
      </div>

      {/* First-time banner */}
      {isFirstTime && (
        <Card className="border-blue-900/50 bg-blue-950/20" data-testid="cc-firsttime">
          <CardContent className="pt-5 space-y-2">
            <div className="text-base font-semibold text-zinc-100">Welcome to ARX AI</div>
            <div className="text-sm text-zinc-300">Risk Governor is active with safe defaults. Get started:</div>
            <ul className="text-xs text-zinc-400 list-disc pl-5 space-y-1">
              <li>Connect MT5 to begin tracking</li>
              <li>Start a demo session</li>
              <li>Create your first playbook</li>
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* MT5 Bridge */}
        <Card data-testid="card-mt5">
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Plug className="w-4 h-4" /> MT5 Bridge</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex items-center gap-2">
              <StatusDot tone={c.mt5Bridge.status === "connected" ? "ok" : c.mt5Bridge.status === "stale" ? "warn" : c.mt5Bridge.status === "disconnected" ? "bad" : "muted"} />
              <span className="capitalize">{c.mt5Bridge.status}</span>
            </div>
            {c.mt5Bridge.isEmpty
              ? <EmptyHint hint={c.mt5Bridge.emptyHint} cta="Connect MT5" to="/my-mt5" />
              : <div className="text-xs text-zinc-400">
                  {c.mt5Bridge.broker ?? "—"} · #{c.mt5Bridge.account ?? "—"}
                  <div>Read-only · Live locked</div>
                </div>}
          </CardContent>
        </Card>

        {/* Session */}
        <Card data-testid="card-session">
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Activity className="w-4 h-4" /> Active Session</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            {c.session.isEmpty
              ? <EmptyHint hint={c.session.emptyHint} cta="Start session" to="/my-performance" />
              : <>
                  <div className="flex items-center gap-2"><StatusDot tone={c.session.status === "active" ? "ok" : "muted"} /><span className="capitalize">{c.session.status}</span></div>
                  <div className="text-xs text-zinc-400">{c.session.title} · {c.session.durationMinutes}m · {c.session.tradesTaken} trades · P/L {c.session.pnl}</div>
                </>}
          </CardContent>
        </Card>

        {/* Risk Governor */}
        <Card data-testid="card-risk">
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><ShieldCheck className="w-4 h-4" /> Risk Governor</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex items-center gap-2">
              <StatusDot tone={c.risk.status === "safe" ? "ok" : c.risk.status === "warning" ? "warn" : "bad"} />
              <span className="capitalize">{c.risk.status}</span>
            </div>
            <div className="text-xs text-zinc-400">
              {c.risk.tradesToday}/{c.risk.maxTradesPerDay ?? "∞"} trades · {c.risk.consecutiveLosses}/{c.risk.maxConsecutiveLosses ?? "∞"} losses
              {c.risk.cooldownMinutesRemaining > 0 && <div>Cooldown: {c.risk.cooldownMinutesRemaining}m remaining</div>}
              {c.risk.reason && <div className="text-rose-400 mt-1">{c.risk.reason}</div>}
            </div>
          </CardContent>
        </Card>

        {/* Today's Performance (server payload field `paperPerformance` will be renamed in Phase 5) */}
        <Card data-testid="card-perf">
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2">Today&apos;s Performance</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            {c.paperPerformance.isEmpty
              ? <EmptyHint hint={c.paperPerformance.emptyHint} />
              : <>
                  <div className={c.paperPerformance.todayPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>P/L {c.paperPerformance.todayPnl}</div>
                  <div className="text-xs text-zinc-400">{c.paperPerformance.winRate}% win · {c.paperPerformance.tradesToday} trades</div>
                </>}
          </CardContent>
        </Card>

        {/* Trade Quality Score */}
        <Card data-testid="card-tqs">
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Target className="w-4 h-4" /> Trade Quality</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            {c.tradeQuality.isEmpty
              ? <EmptyHint hint="Close your first trade to get a quality score." />
              : <>
                  <div className="text-2xl font-semibold">{c.tradeQuality.score}</div>
                  <div className="text-xs text-zinc-400 capitalize">{c.tradeQuality.label}</div>
                  {c.tradeQuality.nextImprovement && <div className="text-xs text-zinc-500">{c.tradeQuality.nextImprovement}</div>}
                </>}
          </CardContent>
        </Card>

        {/* AI Coach */}
        <Card data-testid="card-coach">
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Bot className="w-4 h-4" /> AI Coach</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            {c.aiCoach.isEmpty
              ? <EmptyHint hint="No AI insights yet" />
              : <>
                  <div className="text-xs">Grade: <span className="font-semibold">{c.aiCoach.overallGrade}</span> · {c.aiCoach.overallScore}</div>
                  {c.aiCoach.focus && <div className="text-xs text-zinc-400">Focus: {c.aiCoach.focus}</div>}
                </>}
          </CardContent>
        </Card>

        {/* Playbook Discipline */}
        <Card data-testid="card-playbook">
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><BookOpen className="w-4 h-4" /> Playbook Discipline</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            {c.playbookDiscipline.isEmpty
              ? <EmptyHint hint={c.playbookDiscipline.emptyHint} cta="Create" to="/playbook" />
              : <>
                  <div className="text-xs">{c.playbookDiscipline.active}/{c.playbookDiscipline.total} active</div>
                  <div className="text-xs text-zinc-400">{c.playbookDiscipline.checklistPassRate}% checklist pass · {c.playbookDiscipline.withoutPlaybookCount} trades without playbook</div>
                </>}
          </CardContent>
        </Card>
      </div>

      {/* Alerts */}
      <Card data-testid="card-alerts">
        <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Bell className="w-4 h-4" /> Alerts {alerts.data && alerts.data.unread > 0 && <Badge variant="destructive" className="ml-2">{alerts.data.unread}</Badge>}</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {!alerts.data || alerts.data.isEmpty
            ? <div className="text-xs text-zinc-500">No active alerts.</div>
            : <ul className="space-y-1">
                {alerts.data.alerts.slice(0, 5).map((a: any) => (
                  <li key={a.id} className="flex items-start justify-between gap-2 border-b border-zinc-800/60 pb-1" data-testid={`alert-${a.id}`}>
                    <div className="flex items-start gap-2">
                      <AlertTriangle className={`w-3.5 h-3.5 mt-0.5 ${a.severity === "critical" ? "text-rose-400" : a.severity === "warning" ? "text-amber-400" : "text-zinc-400"}`} />
                      <div>
                        <div className="text-xs font-medium">{a.title}</div>
                        <div className="text-[11px] text-zinc-400">{a.message}</div>
                      </div>
                    </div>
                    <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => dismiss.mutate(a.id)} aria-label="Dismiss"><X className="w-3 h-3" /></Button>
                  </li>
                ))}
              </ul>}
        </CardContent>
      </Card>

      {/* Quick Actions — only relevant ones */}
      <div className="flex flex-wrap gap-2" data-testid="quick-actions">
        {c.mt5Bridge.isEmpty && <Link href="/my-mt5"><Button size="sm" variant="outline">Connect MT5</Button></Link>}
        {c.session.isEmpty && <Link href="/demo-trading"><Button size="sm" variant="outline">Start demo session</Button></Link>}
        {!c.session.isEmpty && <Link href="/demo-trading"><Button size="sm" variant="outline">Open demo trading</Button></Link>}
        {!c.paperPerformance.isEmpty && <Link href="/journal"><Button size="sm" variant="outline">Open journal</Button></Link>}
        {!c.aiCoach.isEmpty && <Link href="/my-performance"><Button size="sm" variant="outline">Review last trade</Button></Link>}
        {c.playbookDiscipline.isEmpty && <Link href="/playbook"><Button size="sm" variant="outline">Create playbook</Button></Link>}
      </div>
    </div>
  );
}
