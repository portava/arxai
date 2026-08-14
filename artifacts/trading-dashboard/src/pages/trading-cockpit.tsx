import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ShieldAlert, ShieldCheck, Activity, Bell, BookOpen, Bot,
  PauseCircle, PlayCircle, StopCircle, FlaskConical, Heart, Target,
  TrendingUp, TrendingDown, Minus, AlertTriangle, ChevronDown, ChevronUp,
  GraduationCap, LifeBuoy,
} from "lucide-react";
import { HelpDrawer } from "@/components/help/HelpDrawer";
import { WhyBlockedDrawer } from "@/components/help/WhyBlockedDrawer";
import { AaciSyncChip } from "@/components/aaci/AaciSyncChip";
import { useChartSymbol, bareSymbol } from "@/lib/use-chart-symbol";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

type CockpitNextAction = { code: string; label: string; cta: string; severity: "INFO" | "WARN" | "BLOCK" };

interface CockpitSummary {
  cockpit_id: string;
  generated_at: string;
  mode: "PAPER_ONLY";
  liveTradingStatus: "DISABLED";
  canPlaceLiveTrade: false;
  canProceedToLiveTrading: false;
  readiness: { status?: string; score?: number; grade?: string; paperTestingAllowed?: boolean; generatedAt?: string };
  riskGovernor: { overallStatus?: string; paperTradingAllowed?: boolean; autopilotAllowed?: boolean; readinessScore?: number; readinessGrade?: string; readinessLevel?: string; hardBlocks?: { code: string; message: string }[]; softWarnings?: { code: string; message: string }[] };
  security: { rolesSeeded: boolean; forbiddenLocked: boolean; secretsRedacted: string };
  activeSession: null | {
    paper_session_id: string; status: string; mode: string; liveTradingStatus: string;
    started_at: string; symbols: string[]; timeframes: string[];
    sessionRules: Record<string, unknown>;
    paperTradesOpened: number; paperTradesClosed: number; netPnl: number; winRate: number;
    activeWarnings: { code: string; message: string }[];
  };
  todayPerformance: { totalTrades: number; wins: number; losses: number; breakEven: number; netPnl: number; winRate: number; dayRating: string };
  openPaperTrades: { id: number; symbol: string; direction: string; lotSize: number; entryPrice: number; stopLoss: number; takeProfit: number; status: string; openedAt: string; profitLoss: number }[];
  coachSummary: { dailyFocus: string; mistakeToAvoid: string[]; setupsToWatch: string[]; setupsToAvoid: string[]; nextBestActions: string[] };
  notifications: { unreadAll: number; criticalUnread: number; criticalSamples: { id: number; type: string; priority: string; title: string; message: string; createdAt: string }[] };
  autopilot: { mode: string; liveTradingAllowed: false; allowedBySession: boolean; allowedByGovernor: boolean; sessionStatus: string; cooldowns: unknown[]; note: string };
  systemHealth: { overallHealth: string; readinessScore: number | null; readinessGrade: string | null; lastReadinessAt: string | null; riskGovernorStatus: string; majorWarnings: { code: string; message: string }[] };
  nextBestAction: CockpitNextAction;
  warnings: string[];
}

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}
async function postJSON<T>(path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return r.json();
}

function StatusBadge({ status }: { status?: string }) {
  const s = (status ?? "UNKNOWN").toUpperCase();
  const tone = s === "PASS" || s === "PASS_WITH_WARNINGS" || s === "PAPER_ALLOWED" || s === "PAPER_CAUTION" || s === "ACTIVE" || s === "OK"
    ? "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30"
    : s === "PAPER_PAUSED" || s === "PAUSED" || s === "WATCH_ONLY" || s === "DEGRADED"
    ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30"
    : s === "FAIL" || s === "BLOCKED" || s === "LOCKED" || s === "UNSAFE"
    ? "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30"
    : "bg-muted text-muted-foreground border-border";
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono border ${tone}`}>{s}</span>;
}

function SafetyHeader({ s }: { s: CockpitSummary }) {
  const critical = s.notifications.criticalUnread > 0;
  const [chartSym] = useChartSymbol();
  return (
    <div className="sticky top-0 z-20 -mx-4 px-4 py-3 bg-background/95 backdrop-blur border-b">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30 hover:bg-blue-500/20" variant="outline">DEMO ONLY</Badge>
        <Badge className="bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30 hover:bg-red-500/20" variant="outline">LIVE TRADING DISABLED</Badge>
        <AaciSyncChip symbol={bareSymbol(chartSym)} />
        <span className="text-xs text-muted-foreground hidden sm:inline">|</span>
        <span className="text-xs text-muted-foreground">Readiness</span><StatusBadge status={s.readiness.status} />
        <span className="text-xs text-muted-foreground">Risk</span><StatusBadge status={s.riskGovernor.overallStatus} />
        <span className="text-xs text-muted-foreground">Security</span>
        {s.security.rolesSeeded && s.security.forbiddenLocked
          ? <Badge variant="outline" className="bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30">OK</Badge>
          : <Badge variant="outline" className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30">WARN</Badge>}
        <span className="text-xs text-muted-foreground">Session</span>
        <StatusBadge status={s.activeSession?.status ?? "NONE"} />
        {critical && (
          <Badge className="bg-red-600 text-white animate-pulse ml-1" variant="default">
            <AlertTriangle className="h-3 w-3 mr-1" />{s.notifications.criticalUnread} CRITICAL ALERT{s.notifications.criticalUnread === 1 ? "" : "S"}
          </Badge>
        )}
      </div>
      {critical && (
        <Alert variant="destructive" className="mt-2">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Critical safety alert must be acknowledged</AlertTitle>
          <AlertDescription className="text-xs">
            Starting a new paper session is disabled until critical alerts are reviewed.
            <Link href="/notifications"><a className="underline ml-1">Open Notifications →</a></Link>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function PrimaryActionCard({ s, onAction, busy }: { s: CockpitSummary; onAction: (kind: "start"|"pause"|"resume"|"end"|"preflight") => void; busy: string | null }) {
  const a = s.nextBestAction;
  const blocked = a.severity === "BLOCK";
  const handle = () => {
    if (a.code === "ACK_CRITICAL") { window.location.href = `${BASE}/notifications`; return; }
    if (a.code === "PREFLIGHT_BLOCKED") { onAction("preflight"); return; }
    if (a.code === "RESUME") { onAction("resume"); return; }
    if (a.code === "MONITOR") { window.location.href = `${BASE}/demo-trading`; return; }
    onAction("start");
  };
  return (
    <Card className={blocked ? "border-red-500/40" : "border-primary/30"}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Target className="h-4 w-4" />Recommended next step
          <Badge variant="outline" className="ml-auto text-[10px]">{a.severity === "BLOCK" ? "ACTION REQUIRED" : "SAFE TO TEST"}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{a.label}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={handle} disabled={busy !== null}>{busy === "primary" ? "Working…" : a.cta}</Button>
          <Button variant="outline" size="sm" onClick={() => onAction("preflight")} disabled={busy !== null}>Run Preflight</Button>
          {s.activeSession?.status === "ACTIVE" && (
            <Button variant="outline" size="sm" onClick={() => onAction("pause")} disabled={busy !== null}><PauseCircle className="h-4 w-4 mr-1" />Pause</Button>
          )}
          {s.activeSession?.status === "PAUSED" && (
            <Button variant="outline" size="sm" onClick={() => onAction("resume")} disabled={busy !== null}><PlayCircle className="h-4 w-4 mr-1" />Resume</Button>
          )}
          {s.activeSession && (
            <Button variant="destructive" size="sm" onClick={() => onAction("end")} disabled={busy !== null}><StopCircle className="h-4 w-4 mr-1" />End</Button>
          )}
        </div>
        {s.warnings.length > 0 && (
          <ul className="text-xs text-amber-700 dark:text-amber-400 list-disc pl-5 space-y-0.5">
            {s.warnings.slice(0, 3).map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ActiveSessionPanel({ s }: { s: CockpitSummary }) {
  const a = s.activeSession;
  if (!a) {
    return (
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Activity className="h-4 w-4" />Active paper session</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No active paper session. Run preflight, then start a paper session to begin.</p>
        </CardContent>
      </Card>
    );
  }
  const elapsedMin = Math.max(0, Math.round((Date.now() - new Date(a.started_at).getTime()) / 60000));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center justify-between">
          <span className="flex items-center gap-2"><Activity className="h-4 w-4" />Active paper session</span>
          <StatusBadge status={a.status} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <div><div className="text-[10px] uppercase text-muted-foreground">Symbols</div><div className="font-mono text-xs">{a.symbols.join(", ") || "—"}</div></div>
          <div><div className="text-[10px] uppercase text-muted-foreground">Timeframes</div><div className="font-mono text-xs">{a.timeframes.join(", ") || "—"}</div></div>
          <div><div className="text-[10px] uppercase text-muted-foreground">Elapsed</div><div className="font-mono text-xs">{elapsedMin} min</div></div>
          <div><div className="text-[10px] uppercase text-muted-foreground">Trades</div><div className="font-mono text-xs">{a.paperTradesOpened} open / {a.paperTradesClosed} closed</div></div>
          <div><div className="text-[10px] uppercase text-muted-foreground">Net P&L (cents)</div><div className={`font-mono text-xs ${a.netPnl > 0 ? "text-green-600" : a.netPnl < 0 ? "text-red-600" : ""}`}>{a.netPnl}</div></div>
          <div><div className="text-[10px] uppercase text-muted-foreground">Win rate</div><div className="font-mono text-xs">{a.winRate}%</div></div>
        </div>
        {a.activeWarnings.length > 0 && (
          <ul className="text-xs text-amber-700 dark:text-amber-400 list-disc pl-5">
            {a.activeWarnings.map((w, i) => <li key={i}>{w.message}</li>)}
          </ul>
        )}
        <Link href="/demo-trading"><a className="text-xs underline">Open session detail →</a></Link>
      </CardContent>
    </Card>
  );
}

function OpenTradesPanel({ s }: { s: CockpitSummary }) {
  const t = s.openPaperTrades;
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><FlaskConical className="h-4 w-4" />Open paper trades</CardTitle></CardHeader>
      <CardContent>
        {t.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open paper trades. They will appear here when paper execution opens positions.</p>
        ) : (
          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase text-muted-foreground">
                <tr><th className="text-left px-2 py-1">Symbol</th><th className="text-left px-2 py-1">Side</th><th className="text-right px-2 py-1">Entry</th><th className="text-right px-2 py-1 hidden sm:table-cell">SL</th><th className="text-right px-2 py-1 hidden sm:table-cell">TP</th><th className="text-right px-2 py-1">P&L</th></tr>
              </thead>
              <tbody>
                {t.map(o => (
                  <tr key={o.id} className="border-t">
                    <td className="px-2 py-1 font-mono">{o.symbol}</td>
                    <td className="px-2 py-1"><Badge variant="outline" className="text-[10px]">{o.direction}</Badge></td>
                    <td className="px-2 py-1 text-right font-mono">{o.entryPrice}</td>
                    <td className="px-2 py-1 text-right font-mono hidden sm:table-cell">{o.stopLoss}</td>
                    <td className="px-2 py-1 text-right font-mono hidden sm:table-cell">{o.takeProfit}</td>
                    <td className={`px-2 py-1 text-right font-mono ${o.profitLoss > 0 ? "text-green-600" : o.profitLoss < 0 ? "text-red-600" : ""}`}>{o.profitLoss}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TodayPerfPanel({ s }: { s: CockpitSummary }) {
  const t = s.todayPerformance;
  const Icon = t.dayRating === "GREEN" ? TrendingUp : t.dayRating === "RED" ? TrendingDown : Minus;
  const tone = t.dayRating === "GREEN" ? "text-green-600" : t.dayRating === "RED" ? "text-red-600" : "text-muted-foreground";
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Icon className={`h-4 w-4 ${tone}`} />Today's performance</CardTitle></CardHeader>
      <CardContent className="text-sm">
        {t.totalTrades === 0 ? (
          <p className="text-muted-foreground">No closed paper trades yet today. Take only A-grade setups and debrief each one.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <div><div className="text-[10px] uppercase text-muted-foreground">Trades</div><div className="font-mono">{t.totalTrades}</div></div>
            <div><div className="text-[10px] uppercase text-muted-foreground">W / L / BE</div><div className="font-mono">{t.wins} / {t.losses} / {t.breakEven}</div></div>
            <div><div className="text-[10px] uppercase text-muted-foreground">Net P&L</div><div className={`font-mono ${tone}`}>{t.netPnl}</div></div>
            <div><div className="text-[10px] uppercase text-muted-foreground">Win rate</div><div className="font-mono">{t.winRate}%</div></div>
            <div className="col-span-2"><div className="text-[10px] uppercase text-muted-foreground">Day rating</div><Badge variant="outline" className={tone}>{t.dayRating}</Badge></div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CoachPanel({ s }: { s: CockpitSummary }) {
  const c = s.coachSummary;
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><BookOpen className="h-4 w-4" />Coach guidance</CardTitle></CardHeader>
      <CardContent className="text-sm space-y-2">
        <div><div className="text-[10px] uppercase text-muted-foreground">Daily focus</div><div>{c.dailyFocus}</div></div>
        {c.setupsToWatch.length > 0 && <div><div className="text-[10px] uppercase text-muted-foreground">Setups to watch</div><ul className="list-disc pl-5">{c.setupsToWatch.slice(0, 3).map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
        {c.setupsToAvoid.length > 0 && <div><div className="text-[10px] uppercase text-muted-foreground">Setups to avoid</div><ul className="list-disc pl-5">{c.setupsToAvoid.slice(0, 3).map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
        <div><div className="text-[10px] uppercase text-muted-foreground">Next best actions</div><ul className="list-disc pl-5">{c.nextBestActions.slice(0, 3).map((x, i) => <li key={i}>{x}</li>)}</ul></div>
        <Link href="/trader-coach"><a className="text-xs underline">Open full coach report →</a></Link>
      </CardContent>
    </Card>
  );
}

function AlertsPanel({ s }: { s: CockpitSummary }) {
  const n = s.notifications;
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Bell className="h-4 w-4" />Alerts</CardTitle></CardHeader>
      <CardContent className="text-sm space-y-2">
        <div className="flex gap-3 text-xs">
          <span>Unread: <span className="font-mono">{n.unreadAll}</span></span>
          <span>Critical: <span className={`font-mono ${n.criticalUnread > 0 ? "text-red-600" : ""}`}>{n.criticalUnread}</span></span>
        </div>
        {n.criticalSamples.length === 0 ? (
          <p className="text-muted-foreground text-xs">No critical alerts. Safety status is clean.</p>
        ) : (
          <ul className="space-y-1">
            {n.criticalSamples.map(a => (
              <li key={a.id} className="text-xs border-l-2 border-red-500 pl-2"><span className="font-medium">{a.title}</span> — {a.message}</li>
            ))}
          </ul>
        )}
        <Link href="/notifications"><a className="text-xs underline">Open notifications →</a></Link>
      </CardContent>
    </Card>
  );
}

function AutopilotPanel({ s }: { s: CockpitSummary }) {
  const a = s.autopilot;
  const allowed = a.allowedBySession && a.allowedByGovernor;
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Bot className="h-4 w-4" />Demo autopilot</CardTitle></CardHeader>
      <CardContent className="text-sm space-y-2">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="bg-blue-500/15 text-blue-700 border-blue-500/30">{a.mode}</Badge>
          <Badge variant="outline" className={allowed ? "bg-green-500/15 text-green-700 border-green-500/30" : "bg-muted"}>{allowed ? "ALLOWED" : "GATED OFF"}</Badge>
        </div>
        <div className="text-xs grid grid-cols-2 gap-2">
          <div><div className="text-[10px] uppercase text-muted-foreground">Session</div><div className="font-mono">{a.sessionStatus}</div></div>
          <div><div className="text-[10px] uppercase text-muted-foreground">Cooldowns</div><div className="font-mono">{a.cooldowns.length}</div></div>
        </div>
        <p className="text-xs text-muted-foreground">{a.note}</p>
      </CardContent>
    </Card>
  );
}

function HealthPanel({ s }: { s: CockpitSummary }) {
  const h = s.systemHealth;
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Heart className="h-4 w-4" />System health</CardTitle></CardHeader>
      <CardContent className="text-sm space-y-2">
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div><div className="text-[10px] uppercase text-muted-foreground">Overall</div><StatusBadge status={h.overallHealth} /></div>
          <div><div className="text-[10px] uppercase text-muted-foreground">Risk</div><StatusBadge status={h.riskGovernorStatus} /></div>
          <div><div className="text-[10px] uppercase text-muted-foreground">Readiness</div><div className="font-mono">{h.readinessScore ?? "—"} ({h.readinessGrade ?? "—"})</div></div>
          <div><div className="text-[10px] uppercase text-muted-foreground">Last check</div><div className="font-mono text-[10px]">{h.lastReadinessAt ? new Date(h.lastReadinessAt).toLocaleTimeString() : "—"}</div></div>
        </div>
        {h.majorWarnings.length > 0 && (
          <ul className="text-xs text-amber-700 dark:text-amber-400 list-disc pl-5">
            {h.majorWarnings.slice(0, 3).map((w, i) => <li key={i}>{w.message}</li>)}
          </ul>
        )}
        <Link href="/system-health"><a className="text-xs underline">Open system health →</a></Link>
      </CardContent>
    </Card>
  );
}

function OnboardingWidget() {
  const { data } = useQuery({
    queryKey: ["onboarding-status"],
    queryFn: () => getJSON<{ status: { status: string; currentStep: string | null; completedSteps: string[]; skippedSteps: string[]; totalSteps: number; nextStep: string | null; walkthroughCompleted: boolean } }>("/api/onboarding/status"),
    refetchInterval: 15000,
  });
  if (!data) return null;
  const st = data.status;
  const done = (st.completedSteps?.length ?? 0) + (st.skippedSteps?.length ?? 0);
  const pct = Math.round((done / Math.max(1, st.totalSteps)) * 100);
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2"><GraduationCap className="h-4 w-4" />Onboarding & Help</span>
          <span className="text-xs font-mono">{done}/{st.totalSteps} ({pct}%)</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs">Status: <span className="font-mono">{st.status}</span>{st.nextStep && <> · Next: <span className="font-mono">{st.nextStep}</span></>}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild><a href={`${base}/onboarding`}>{st.status === "NOT_STARTED" ? "Start onboarding" : "Continue onboarding"}</a></Button>
          <Button size="sm" variant="outline" asChild><a href={`${base}/help`}><LifeBuoy className="h-3 w-3 mr-1" />Help Center</a></Button>
          <WhyBlockedDrawer defaultAction="START_PAPER_SESSION" />
          <HelpDrawer route="/trading-cockpit" />
        </div>
      </CardContent>
    </Card>
  );
}

function HelperCopy() {
  const [open, setOpen] = useState(false);
  return (
    <Card className="bg-muted/30">
      <CardHeader className="pb-2 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <CardTitle className="text-sm flex items-center justify-between">
          How this cockpit keeps you safe
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent className="text-xs text-muted-foreground space-y-1">
          <p>• This system is currently <span className="font-mono">PAPER_ONLY</span>. Live trading is disabled.</p>
          <p>• Always run preflight before starting a paper session.</p>
          <p>• The Risk Governor can pause new paper trades when risk gets too high.</p>
          <p>• The Coach turns paper results into clear improvement steps.</p>
          <p>• Replay and Strategy Lab are simulation tools only.</p>
        </CardContent>
      )}
    </Card>
  );
}

export default function TradingCockpit() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["cockpit-summary"],
    queryFn: () => getJSON<{ summary: CockpitSummary }>("/api/trading-cockpit/summary"),
    refetchInterval: 5000,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const sessionId = data?.summary.activeSession?.paper_session_id ?? null;

  const act = useMutation({
    mutationFn: async (kind: "start"|"pause"|"resume"|"end"|"preflight") => {
      const headers = { "x-security-role": "OWNER" };
      if (kind === "preflight") return await postJSON("/api/paper-sessions/preflight", {}, headers);
      if (kind === "start") return await postJSON("/api/paper-sessions/start", {}, headers);
      if (!sessionId) return { error: "no session" };
      return await postJSON(`/api/paper-sessions/${kind}`, { paperSessionId: sessionId }, headers);
    },
    onMutate: () => setBusy("primary"),
    onSettled: () => { setBusy(null); qc.invalidateQueries({ queryKey: ["cockpit-summary"] }); refetch(); },
    onSuccess: (r: { result?: { status?: string; ok?: boolean; reason?: string }; preflight?: { paperTestingAllowed?: boolean; hardBlocks?: { message: string }[] } }) => {
      if (r.preflight) {
        setActionMsg(r.preflight.paperTestingAllowed ? "Preflight: SAFE TO PAPER TEST" : `Preflight BLOCKED: ${r.preflight.hardBlocks?.map(b => b.message).join("; ")}`);
      } else if (r.result) {
        setActionMsg(`${r.result.status ?? (r.result.ok ? "OK" : "REJECTED")}${r.result.reason ? ` — ${r.result.reason}` : ""}`);
      }
      setTimeout(() => setActionMsg(null), 6000);
    },
  });

  useEffect(() => { document.title = "Trading Cockpit — DEMO ONLY"; }, []);

  if (isLoading) {
    return <div className="p-4 space-y-3"><Skeleton className="h-12 w-full" /><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[0,1,2,3,4,5].map(i => <Skeleton key={i} className="h-44 w-full" />)}</div></div>;
  }
  if (error || !data) {
    return <div className="p-4"><Alert variant="destructive"><AlertTitle>Cockpit unavailable</AlertTitle><AlertDescription className="text-xs">Unable to read cockpit summary. Existing safety rules remain in force; live trading remains DISABLED.</AlertDescription></Alert></div>;
  }
  const s = data.summary;

  return (
    <div className="space-y-4 px-1 sm:px-0 pb-8">
      <SafetyHeader s={s} />
      <div className="px-1 sm:px-0">
        <h1 className="text-xl font-bold flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-green-600" />Trading Cockpit</h1>
        <p className="text-xs text-muted-foreground">One clean place to operate the paper-only system. No live execution controls live here — and they never will.</p>
      </div>
      {actionMsg && <Alert><AlertDescription className="text-xs">{actionMsg}</AlertDescription></Alert>}
      <PrimaryActionCard s={s} onAction={(k) => act.mutate(k)} busy={busy} />
      <div className="grid gap-3 lg:grid-cols-3">
        <ActiveSessionPanel s={s} />
        <TodayPerfPanel s={s} />
        <CoachPanel s={s} />
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <AlertsPanel s={s} />
        <AutopilotPanel s={s} />
        <HealthPanel s={s} />
      </div>
      <OpenTradesPanel s={s} />
      <OnboardingWidget />
      <HelperCopy />
      <p className="text-[10px] text-muted-foreground text-center">cockpit_id {s.cockpit_id} • generated {new Date(s.generated_at).toLocaleTimeString()} • PAPER_ONLY • LIVE TRADING DISABLED</p>
    </div>
  );
}
