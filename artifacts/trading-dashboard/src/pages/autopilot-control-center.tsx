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
  discipline: number;
  lastDecision: Decision | null;
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

type Lock = { code: string; tripped: boolean; reason?: string };

const MODE_COLOR: Record<string, string> = {
  OFF: "bg-muted text-txt-secondary",
  OBSERVE_ONLY: "bg-primary/20 text-primary",
  AI_ASSIST: "bg-ruby/20 text-ruby",
  DEMO_AUTO_SIMULATOR: "bg-success/20 text-success",
  LIVE_INTENT_AUTO_TESTER: "bg-warning/20 text-warning",
  FUTURE_MT5_LIVE_AUTO_LOCKED: "bg-premium/20 text-premium",
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
        <Card className="border-warning/40 bg-warning/10">
          <CardContent className="p-4 flex items-start gap-3">
            <ShieldAlert className="h-5 w-5 text-warning mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-warning">
                {roleDenied
                  ? "Access denied — Admin or Owner role required to view the Autopilot Control Center."
                  : loadError}
              </p>
              <p className="text-xs text-warning/70 mt-1">
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
        <Card className="border-danger/40 bg-danger/10">
          <CardContent className="p-3 text-danger text-sm flex items-center gap-2">
            <AlertOctagon className="h-4 w-4" />Kill switch is engaged — autopilot cannot start.
          </CardContent>
        </Card>
      )}

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
          <Stat label="Consec losses" value={String(s.consecutiveLosses)} />
          <Stat label="Discipline" value={`${s.discipline}/100`} />
          <Stat label="MT5" value={s.mt5Connected ? "ON" : "DEFERRED"} />
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Safety locks</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-1">
          {locks.length === 0 && <p className="text-xs text-muted-foreground">No locks data yet.</p>}
          {locks.map((l) => (
            <Badge key={l.code} variant={l.tripped ? "destructive" : "outline"} title={l.reason ?? ""}>
              {l.code}{l.tripped ? " ⚠" : ""}
            </Badge>
          ))}
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
              {d.rulesPassed.length > 0 && <div className="text-success">✓ {d.rulesPassed.join(", ")}</div>}
              {d.rulesFailed.length > 0 && <div className="text-danger">✗ {d.rulesFailed.join(", ")}</div>}
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

function Stat({ label, value }: { label: string; value: string }) {
  return <Card><CardContent className="p-2">
    <p className="text-[10px] text-muted-foreground uppercase">{label}</p>
    <p className="text-sm font-mono font-semibold">{value}</p>
  </CardContent></Card>;
}
