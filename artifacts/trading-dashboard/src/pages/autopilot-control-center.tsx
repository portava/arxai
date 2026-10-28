import { useEffect, useState } from "react";
import { useProductRole } from "@/hooks/useProductRole";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Bot, Play, Pause, StopCircle, AlertOctagon, Zap, ThumbsUp, ThumbsDown, Brain, ShieldAlert } from "lucide-react";

type Status = {
  mode: string; state: string;
  session: { sessionId: string; name: string; mode: string; strategy: string; status: string; rules: Record<string, unknown> } | null;
  lastScanTs: string | null; nextScanInSec: number;
  consecutiveLosses: number;
  openSimulatedPositions: number;
  dailyRiskRemainingUsd: number; dailyTradesRemaining: number;
  activeRiskLocks: string[];
  mt5Connected: boolean; killSwitchEngaged: boolean;
  /** False when nothing feeds the losing-streak counter (it then stays 0). Missing = not reported. */
  consecutiveLossesMeasured?: boolean;
  /** The platform's install-wide stops as they bear on the autopilot. Missing = not reported. */
  platformStop?: PlatformStop;
  discipline: number;
  lastDecision: Decision | null;
};

type PlatformStopSource = {
  source: string; reason: string | null; engagedAt: string | null; haltsAutopilotOrders: boolean;
};
type PlatformStop = {
  readable: boolean; engaged: boolean; sources: PlatformStopSource[];
  haltsAutopilotOrders: boolean; readByAutopilot: boolean; checkedAt: string;
};

type Decision = {
  decisionId: string; ts: string; symbol: string; timeframe: string; strategy: string;
  considered: string; action: string; reason: string;
  confidenceScore: number; opportunityScore: number; entrySniperScore: number; tradeGrade: number; riskScore: number;
  rulesPassed: string[]; rulesFailed: string[];
  marketHealth: string; newsRisk: string; sessionRisk: string;
  finalDecision: string; nextAction: string; orderId?: string;
  humanOverride?: { mark: string; note?: string };
};

type Lock = {
  code: string; tripped: boolean; reason?: string; ts?: string;
  /** True only when some autopilot code path sets this lock. Missing = not confirmed. */
  evaluated?: boolean;
  lastCheckedAt?: string | null;
  checks?: string;
};

const PLATFORM_STOP_NAME: Record<string, string> = {
  safety_core_kill_switch: "Safety-core kill switch",
  platform_emergency_stop: "Platform emergency stop",
};

/** What a lock badge may claim. A lock reads "clear" only when the autopilot checked it. */
function lockReading(l: Lock): { label: string; tone: "set" | "clear" | "unchecked" } {
  if (l.tripped) return { label: "set", tone: "set" };
  if (l.evaluated !== true) return { label: "not checked", tone: "unchecked" };
  if (!l.lastCheckedAt) return { label: "not checked yet", tone: "unchecked" };
  return { label: "clear", tone: "clear" };
}

function fmtTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : null;
}

const MODE_COLOR: Record<string, string> = {
  OFF: "bg-zinc-500/20 text-zinc-300",
  OBSERVE_ONLY: "bg-blue-500/20 text-blue-400",
  AI_ASSIST: "bg-cyan-500/20 text-cyan-400",
  DEMO_AUTO_SIMULATOR: "bg-emerald-500/20 text-emerald-400",
  LIVE_INTENT_AUTO_TESTER: "bg-amber-500/20 text-amber-400",
  FUTURE_MT5_LIVE_AUTO_LOCKED: "bg-purple-500/20 text-purple-400",
};

async function api(path: string, init?: RequestInit) {
  const r = await fetch(path, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init,
  });
  const body = await r.json();
  if (!r.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${r.status}`), { status: r.status, body });
  return body;
}

async function apiFetch(path: string): Promise<unknown> {
  const r = await fetch(path);
  const body = await r.json();
  if (!r.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${r.status}`), { status: r.status, body });
  return body;
}

export default function AutopilotControlCenter() {
  // Lightweight pre-check against the cached /api/me identity (React Query,
  // already in-flight on app load). Non-admins get the access-denied state
  // immediately without firing any autopilot API calls. Display-only: the
  // server-side requireAdmin guard on every /api/autopilot/* route remains
  // the authority, and the 403 handler below stays as defense in depth.
  const { isAdmin, isLoading: roleLoading } = useProductRole();
  const roleDenied = !roleLoading && !isAdmin;
  const [s, setS] = useState<Status | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [locks, setLocks] = useState<Lock[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "Default Safe Session",
    mode: "DEMO_AUTO_SIMULATOR",
    strategy: "trend",
    symbols: "EURUSD,GBPUSD",
    maxTrades: 3,
    requireApproval: false,
  });

  async function load() {
    try {
      const [st, dc, lk] = await Promise.all([
        apiFetch("/api/autopilot/status"),
        apiFetch("/api/autopilot/decisions?limit=20"),
        apiFetch("/api/autopilot/safety-locks"),
      ]);
      setLoadError(null);
      setS(st as Status);
      setDecisions(((dc as { decisions?: Decision[] }).decisions) ?? []);
      setLocks(((lk as { locks?: Lock[] }).locks) ?? []);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 403) {
        setLoadError("Access denied — Admin or Owner role required to view the Autopilot Control Center.");
      } else {
        setLoadError(`Could not load autopilot status: ${e.message ?? "unknown error"}`);
      }
    }
  }
  useEffect(() => {
    // Don't fire any autopilot API calls until identity is resolved, and
    // never for non-admin roles (they get the access-denied state below).
    if (roleLoading || !isAdmin) return;
    void load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [roleLoading, isAdmin]);

  async function start() {
    await api("/api/autopilot/start", { method: "POST", body: JSON.stringify({
      name: form.name, mode: form.mode, strategy: form.strategy,
      requireApproval: form.requireApproval,
      rules: { symbols: form.symbols.split(",").map((x) => x.trim()).filter(Boolean), maxTrades: Number(form.maxTrades) },
    })});
    load();
  }
  async function ctl(kind: string) {
    await api("/api/autopilot/human-override", { method: "POST", body: JSON.stringify({ kind })});
    load();
  }
  async function approve(id: string) { await api("/api/autopilot/human-override", { method: "POST", body: JSON.stringify({ kind: "APPROVE", decisionId: id })}); load(); }
  async function rejectD(id: string) { await api("/api/autopilot/human-override", { method: "POST", body: JSON.stringify({ kind: "REJECT", decisionId: id })}); load(); }
  async function mark(id: string, m: "GOOD" | "BAD") { await api("/api/autopilot/mark-decision", { method: "POST", body: JSON.stringify({ decisionId: id, mark: m })}); load(); }

  if (roleLoading) {
    // Identity still resolving — render a neutral shell, fire no API calls,
    // and make no containment decision yet (unresolved role ≠ denied).
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Bot className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">AI Autopilot Control Center</h1>
        </div>
        <p className="text-sm text-muted-foreground">Checking access…</p>
      </div>
    );
  }

  if (roleDenied || loadError) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Bot className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">AI Autopilot Control Center</h1>
        </div>
        <Card className="border-amber-500/40 bg-amber-500/10">
          <CardContent className="p-4 flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-300">
                {roleDenied
                  ? "Access denied — Admin or Owner role required to view the Autopilot Control Center."
                  : loadError}
              </p>
              <p className="text-xs text-amber-400/70 mt-1">
                This control center is restricted to Admin and Owner sessions. The autopilot runs
                in SIMULATOR mode only — no live broker execution.
              </p>
              {!roleDenied && (
                <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>
                  Retry
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Bot className="h-6 w-6 text-primary" />
        <div className="flex-1">
          <h1 className="text-2xl font-bold">AI Autopilot Control Center</h1>
          <p className="text-sm text-muted-foreground">Coordinate scanner + risk + OMS into supervised AI runs. MT5 live execution is locked until the bridge is connected.</p>
        </div>
        <Badge variant="outline">SIMULATOR</Badge>
        {s && <Badge className={MODE_COLOR[s.mode] ?? ""}>{s.mode}</Badge>}
        {s && <Badge variant="outline">state {s.state}</Badge>}
      </div>

      {s?.killSwitchEngaged && (
        <Card className="border-rose-500/40 bg-rose-500/10" data-testid="autopilot-emergency-stop">
          <CardContent className="p-3 text-rose-300 text-sm flex items-start gap-2">
            <AlertOctagon className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Autopilot emergency stop is engaged{fmtTime(locks.find((l) => l.code === "KILL_SWITCH")?.ts) ? ` since ${fmtTime(locks.find((l) => l.code === "KILL_SWITCH")?.ts)}` : ""}.
              New sessions and scans are refused. Nothing on this page releases it; it clears only when the API server restarts.
              This is the autopilot's own stop, not the platform kill switch.
            </span>
          </CardContent>
        </Card>
      )}

      {s && <PlatformStopNotice stop={s.platformStop} />}

      <Card>
        <CardHeader><CardTitle className="text-base">Start session</CardTitle>
          <CardDescription>Default profile is safe: DEMO_AUTO_SIMULATOR · 3 trades · 1 open · 0.25% risk · stop after 1 loss · 15 min cooldown · Risk Governor required.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-6">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="session name" className="md:col-span-2" />
          <select className="border rounded px-2 bg-background" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
            <option>OBSERVE_ONLY</option>
            <option>AI_ASSIST</option>
            <option>DEMO_AUTO_SIMULATOR</option>
            <option>LIVE_INTENT_AUTO_TESTER</option>
            <option disabled>FUTURE_MT5_LIVE_AUTO_LOCKED</option>
          </select>
          <Input value={form.strategy} onChange={(e) => setForm({ ...form, strategy: e.target.value })} placeholder="strategy" />
          <Input value={form.symbols} onChange={(e) => setForm({ ...form, symbols: e.target.value })} placeholder="symbols" />
          <Input type="number" value={form.maxTrades} onChange={(e) => setForm({ ...form, maxTrades: Number(e.target.value) })} placeholder="max trades" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.requireApproval} onChange={(e) => setForm({ ...form, requireApproval: e.target.checked })} />
            Require approval
          </label>
          <div className="md:col-span-6 flex gap-2 flex-wrap">
            <Button onClick={start}><Play className="h-4 w-4 mr-1" />Start</Button>
            <Button variant="outline" onClick={() => ctl("PAUSE")}><Pause className="h-4 w-4 mr-1" />Pause</Button>
            <Button variant="outline" onClick={() => ctl("RESUME")}><Play className="h-4 w-4 mr-1" />Resume</Button>
            <Button variant="outline" onClick={() => ctl("STOP")}><StopCircle className="h-4 w-4 mr-1" />Stop</Button>
            <Button variant="destructive" onClick={() => ctl("EMERGENCY_STOP")}><AlertOctagon className="h-4 w-4 mr-1" />Emergency Stop</Button>
            <Button variant="secondary" onClick={() => ctl("FORCE_SCAN")}><Zap className="h-4 w-4 mr-1" />Force Scan</Button>
          </div>
        </CardContent>
      </Card>

      {s && (
        <div className="grid gap-2 md:grid-cols-4">
          <Stat label="Mode" value={s.mode} />
          <Stat label="State" value={s.state} />
          <Stat label="Open positions" value={String(s.openSimulatedPositions)} />
          <Stat label="Daily risk left" value={`$${s.dailyRiskRemainingUsd}`} />
          <Stat label="Trades remaining" value={String(s.dailyTradesRemaining)} />
          <Stat label="Consec losses" value={s.consecutiveLossesMeasured === true ? String(s.consecutiveLosses) : "not measured"} />
          <Stat label="Discipline" value={`${s.discipline}/100`} />
          <Stat label="MT5" value={s.mt5Connected ? "ON" : "DEFERRED"} />
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Safety locks</CardTitle>
          <CardDescription>
            A lock reads clear only after the autopilot checked it. A lock marked "not checked" has no autopilot check behind it.
            A set lock stays set until the API server restarts. Only KILL_SWITCH stops sessions and scans.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {locks.length === 0 && <p className="text-xs text-muted-foreground">No locks data yet.</p>}
          <div className="flex flex-wrap gap-1">
            {locks.map((l) => {
              const r = lockReading(l);
              const when = fmtTime(l.tripped ? l.ts : l.lastCheckedAt);
              return (
                <Badge
                  key={l.code}
                  data-testid={`lock-${l.code}`}
                  variant={r.tone === "set" ? "destructive" : "outline"}
                  className={r.tone === "unchecked" ? "border-dashed text-muted-foreground" : undefined}
                  title={[l.reason, l.checks, when ? `as of ${when}` : null].filter(Boolean).join(" — ")}
                >
                  {l.code} · {r.label}
                </Badge>
              );
            })}
          </div>
          {locks.some((l) => lockReading(l).tone === "unchecked") && (
            <p className="text-xs text-muted-foreground" data-testid="locks-unchecked">
              Not checked by the autopilot: {locks.filter((l) => lockReading(l).tone === "unchecked").map((l) => l.code).join(", ")}.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Brain className="h-4 w-4" />Decisions</CardTitle>
          <CardDescription>Each AI decision shows scores, rules passed/failed, market context, and next action.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {decisions.length === 0 && <p className="text-xs text-muted-foreground">No decisions yet — start a session and force a scan.</p>}
          {decisions.map((d) => (
            <div key={d.decisionId} className="border rounded p-2 text-xs space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{d.action}</Badge>
                <span className="font-semibold">{d.symbol}</span>
                <Badge variant="outline">{d.timeframe}</Badge>
                <Badge variant="outline">{d.strategy}</Badge>
                <span className="text-muted-foreground">{d.reason}</span>
                <span className="ml-auto text-muted-foreground">{new Date(d.ts).toLocaleTimeString()}</span>
              </div>
              <div className="flex flex-wrap gap-2 text-muted-foreground">
                <span>conf {d.confidenceScore}</span><span>opp {d.opportunityScore}</span>
                <span>sniper {d.entrySniperScore}</span><span>grade {d.tradeGrade}</span>
                <span>risk {d.riskScore}</span>
                <span>mh {d.marketHealth}</span><span>news {d.newsRisk}</span><span>session {d.sessionRisk}</span>
              </div>
              {d.rulesPassed.length > 0 && <div className="text-emerald-400">✓ {d.rulesPassed.join(", ")}</div>}
              {d.rulesFailed.length > 0 && <div className="text-rose-400">✗ {d.rulesFailed.join(", ")}</div>}
              <div className="text-muted-foreground">Next: {d.nextAction}</div>
              <div className="flex gap-1 pt-1">
                {d.action === "ASK_USER_APPROVAL" && (
                  <>
                    <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => approve(d.decisionId)}>Approve</Button>
                    <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => rejectD(d.decisionId)}>Reject</Button>
                  </>
                )}
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => mark(d.decisionId, "GOOD")}><ThumbsUp className="h-3 w-3" /></Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => mark(d.decisionId, "BAD")}><ThumbsDown className="h-3 w-3" /></Button>
                {d.humanOverride && <Badge variant="outline">marked {d.humanOverride.mark}</Badge>}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function PlatformStopNotice({ stop }: { stop: PlatformStop | undefined }) {
  if (!stop) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="platform-stop">
        Platform kill switch: not reported by the server.
      </p>
    );
  }
  const asOf = fmtTime(stop.checkedAt);
  if (!stop.readable) {
    return (
      <Card className="border-amber-500/40 bg-amber-500/10" data-testid="platform-stop">
        <CardContent className="p-3 text-amber-300 text-sm">
          Could not read the platform kill switch{asOf ? ` (checked ${asOf})` : ""}. The pre-trade Risk Governor treats a stop it
          cannot read as engaged, so it refuses the autopilot's simulator orders. The autopilot itself does not read this switch.
        </CardContent>
      </Card>
    );
  }
  if (!stop.engaged) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="platform-stop">
        Platform kill switch and emergency stop: released{asOf ? ` as of ${asOf}` : ""}.
      </p>
    );
  }
  return (
    <Card className="border-rose-500/40 bg-rose-500/10" data-testid="platform-stop">
      <CardContent className="p-3 text-rose-300 text-sm space-y-1">
        {stop.sources.map((src) => {
          const since = fmtTime(src.engagedAt);
          return (
            <p key={src.source}>
              {PLATFORM_STOP_NAME[src.source] ?? src.source} is engaged{since ? ` since ${since}` : ""}{src.reason ? ` (${src.reason})` : ""}.{" "}
              {src.haltsAutopilotOrders
                ? "The pre-trade Risk Governor refuses every simulator order the autopilot places."
                : "It does not halt the paper simulator, so it does not refuse the autopilot's simulator orders."}
            </p>
          );
        })}
        <p className="text-xs text-rose-300/80">
          The autopilot does not read the platform stops: sessions can still start and scans still decide{asOf ? ` (checked ${asOf})` : ""}.
        </p>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-2">
    <p className="text-[10px] text-muted-foreground uppercase">{label}</p>
    <p className="text-sm font-mono font-semibold">{value}</p>
  </CardContent></Card>;
}
