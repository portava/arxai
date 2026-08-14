import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CheckCircle2, XCircle, Download, Copy, RefreshCw, ShieldCheck, AlertTriangle, Lock, Server, KeyRound, Plug, ListChecks, Plus, EyeOff, ChevronDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BridgeDiagnosticsPanel } from "@/components/mt5/BridgeDiagnosticsPanel";
import { OneClickToggleCard } from "@/components/mt5/OneClickToggleCard";
import { BridgeV2FeedStatus } from "@/components/mt5/BridgeV2FeedStatus";

type SecretsStatus = {
  provider: string;
  requiredSecrets: { key: string; required: boolean; set: boolean; description?: string }[];
  missingSecrets: string[];
  readOnlyReady: boolean;
  liveTradingAllowedFlag: { set: boolean; value: boolean; note: string };
};
type ConnectionCheck = {
  provider: string;
  connected: boolean;
  environment: string;
  accountIdPresent: boolean;
  bridgeUrlPresent: boolean;
  apiKeyPresent: boolean;
  readOnlyReady: boolean;
  liveOrderReady: boolean;
  missingSecrets: string[];
  checks: {
    accountReadable: boolean; equityReadable: boolean; balanceReadable: boolean; marginReadable: boolean;
    symbolsReadable: boolean; positionsReadable: boolean; ordersReadable: boolean;
    symbolCount: number; positionCount: number; orderCount: number;
  };
  errors: string[];
  lastCheckedAt: string;
};
type BrokerStatus = {
  status: { kind: string; connected: boolean; environment: string; notes: string[] };
};
type BrokerAccount = { account: { accountIdMasked?: string; balance?: number; equity?: number; currency?: string } | null };

function YesNo({ v, yes = "Yes", no = "No" }: { v: boolean; yes?: string; no?: string }) {
  return v ? (
    <Badge className="bg-success/15 text-success border-success/30"><CheckCircle2 className="w-3 h-3 mr-1" />{yes}</Badge>
  ) : (
    <Badge className="bg-danger/15 text-danger border-danger/30"><XCircle className="w-3 h-3 mr-1" />{no}</Badge>
  );
}

async function jget<T>(url: string): Promise<T | null> {
  try { const r = await fetch(url); if (!r.ok) return null; return (await r.json()) as T; } catch { return null; }
}

type ChecklistItem = {
  id: string;
  label: string;
  derivable: boolean;
  state: "ok" | "missing" | "waiting" | "stale" | "manual";
  detail?: string;
};
type ChecklistResponse = {
  items: ChecklistItem[];
  derived: {
    tokenConfigured: boolean;
    bridgeConfigured: boolean;
    bridgeConnected: boolean;
    heartbeatFresh: boolean;
    lastHeartbeatAt: string | null;
    heartbeatAgeSeconds: number | null;
    readOnlyMode: boolean;
    allowOrderExecution: boolean;
    allowModification: boolean;
    allowClose: boolean;
    bridgeMode: string;
    placementLayer: string;
  };
  totals: { manual: number; ok: number; missing: number; waiting: number; stale: number };
  note: string;
  updatedAt: string;
};

function StatePill({ s }: { s: ChecklistItem["state"] }) {
  if (s === "ok") return <Badge className="bg-success/15 text-success border-success/30"><CheckCircle2 className="w-3 h-3 mr-1" />OK</Badge>;
  if (s === "missing") return <Badge className="bg-danger/15 text-danger border-danger/30"><XCircle className="w-3 h-3 mr-1" />Missing</Badge>;
  if (s === "waiting") return <Badge className="bg-secondary/15 text-txt-secondary border-border">Waiting</Badge>;
  if (s === "stale") return <Badge className="bg-warning/15 text-warning border-warning/30"><AlertTriangle className="w-3 h-3 mr-1" />Stale</Badge>;
  return <Badge variant="outline" className="text-txt-secondary border-border">Manual</Badge>;
}

function OperatorSetupChecklistCard() {
  const [data, setData] = useState<ChecklistResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const r = await jget<ChecklistResponse>("/api/mt5/setup-checklist");
      if (cancelled) return;
      if (!r) { setErr("Failed to load checklist."); return; }
      setErr(null); setData(r);
    }
    void load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <Card data-testid="card-operator-checklist">
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="flex items-center gap-2"><ListChecks className="w-4 h-4" /> MT5 Bridge Setup Checklist</CardTitle>
            <CardDescription>14 operator items. Manual items are confirmed by you; derived items reflect live server state. Read-only — no execution unlock.</CardDescription>
          </div>
          {data && (
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline" className="border-success/40 text-success">{data.totals.ok} OK</Badge>
              {data.totals.missing > 0 && <Badge variant="outline" className="border-danger/40 text-danger">{data.totals.missing} missing</Badge>}
              {data.totals.waiting > 0 && <Badge variant="outline" className="border-border text-txt-secondary">{data.totals.waiting} waiting</Badge>}
              {data.totals.stale > 0 && <Badge variant="outline" className="border-warning/40 text-warning">{data.totals.stale} stale</Badge>}
              <Badge variant="outline" className="border-border text-txt-secondary">{data.totals.manual} manual</Badge>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {err && <div className="text-danger text-xs">{err}</div>}
        {!data ? (
          <div className="text-txt-secondary text-xs">Loading checklist…</div>
        ) : (
          <>
            <div className="grid gap-1.5">
              {data.items.map((it) => (
                <div key={it.id} data-testid={`checklist-item-${it.id}`} className="flex items-start justify-between gap-3 py-1.5 border-b border-border last:border-b-0">
                  <div className="flex-1 min-w-0">
                    <div className="text-foreground">{it.label}</div>
                    {it.detail && <div className="text-xs text-txt-muted mt-0.5">{it.detail}</div>}
                  </div>
                  <StatePill s={it.state} />
                </div>
              ))}
            </div>
            <div className="pt-2 grid sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-txt-secondary">
              <div className="flex justify-between"><span>bridgeMode</span><span className="text-foreground">{data.derived.bridgeMode}</span></div>
              <div className="flex justify-between"><span>readOnlyMode</span><span className="text-success">true</span></div>
              <div className="flex justify-between"><span>allowOrderExecution</span><span className="text-danger">false</span></div>
              <div className="flex justify-between"><span>allowModification</span><span className="text-danger">false</span></div>
              <div className="flex justify-between"><span>allowClose</span><span className="text-danger">false</span></div>
              <div className="flex justify-between"><span>placementLayer</span><span className="text-warning text-[10px]">{data.derived.placementLayer}</span></div>
            </div>
            <div className="text-[10px] text-txt-muted pt-1">Updated {new Date(data.updatedAt).toLocaleString()} · Tokens are never returned by this endpoint.</div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Per-user bridge token card.
// SECURITY:
//   - Raw token is shown ONCE on create/regenerate (server returns it exactly
//     once via rawToken; only sha256 hash is persisted in apiKeyHash).
//   - Token value never logged, never printed to console, never sent to
//     analytics, never included in audit-trail/report payloads.
//   - Listing endpoint returns only tokenLast4 — the full value cannot be
//     retrieved afterwards.
//   - This card never touches the MT5_BRIDGE_TOKEN system secret — that
//     secret is server-only and is not exposed by any client endpoint.
type PerUserConn = {
  id: number;
  connectionName: string | null;
  status: string;
  tokenLast4: string | null;
  tokenCreatedAt: string | null;
  tokenRevokedAt: string | null;
  liveLocked: boolean;
  readOnlyMode: boolean;
  allowOrderExecution: boolean;
};

function PerUserBridgeTokenCard() {
  const { toast } = useToast();
  const [conns, setConns] = useState<PerUserConn[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [revealed, setRevealed] = useState<{ raw: string; connId: number } | null>(null);

  async function refresh() {
    try {
      const r = await fetch("/api/me/mt5-connections", { credentials: "include" });
      if (!r.ok) throw new Error(`${r.status}`);
      const data = (await r.json()) as { connections: PerUserConn[] };
      setConns(data.connections);
    } catch {
      // Silent — keep last list. Don't log per-user URL/state.
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, []);

  async function createConn() {
    const name = newName.trim();
    if (!name) return;
    try {
      const r = await fetch("/api/me/mt5-connections", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionName: name }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as PerUserConn & { rawToken: string };
      // SECURITY: rawToken stays in component state only until dismissed.
      setRevealed({ raw: data.rawToken, connId: data.id });
      setCreating(false);
      setNewName("");
      void refresh();
    } catch (e) {
      toast({ title: "Could not create connection", description: String(e), variant: "destructive" });
    }
  }

  async function regenerate(id: number) {
    if (!confirm("Regenerate the per-user bridge token? The previous token will stop working immediately.")) return;
    try {
      const r = await fetch(`/api/me/mt5-connections/${id}/regenerate-token`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as PerUserConn & { rawToken: string };
      setRevealed({ raw: data.rawToken, connId: data.id });
      void refresh();
    } catch (e) {
      toast({ title: "Regenerate failed", description: String(e), variant: "destructive" });
    }
  }

  async function revoke(id: number) {
    if (!confirm("Revoke this per-user bridge token? The EA will stop being able to send heartbeats.")) return;
    try {
      const r = await fetch(`/api/me/mt5-connections/${id}/revoke`, { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      void refresh();
    } catch (e) {
      toast({ title: "Revoke failed", description: String(e), variant: "destructive" });
    }
  }

  function copyToken() {
    if (!revealed) return;
    // SECURITY: clipboard write only; never echoed to console / toast body.
    void navigator.clipboard.writeText(revealed.raw).then(() => {
      toast({ title: "Token copied to clipboard" });
    });
  }

  const activeConns = conns.filter((c) => c.status !== "revoked");

  return (
    <Card className="border-2 border-primary/30 bg-primary/5" data-testid="card-per-user-bridge-token">
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2 text-primary">
              <KeyRound className="w-5 h-5" />
              Per-user bridge token — paste into MT5 EA Inputs → BridgeToken
            </CardTitle>
            <CardDescription className="mt-1">
              Each MT5 EA instance authenticates with its own per-user token.
              Tokens are visible to you only and are shown exactly once at
              creation. The system <code>MT5_BRIDGE_TOKEN</code> secret is
              <em> not</em> displayed here and is never returned to the browser.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreating(true)} data-testid="button-create-per-user-token">
            <Plus className="w-4 h-4 mr-1" /> New connection token
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <Alert className="border-warning/40 bg-warning/10">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle className="text-warning">Do not screenshot or share this token.</AlertTitle>
          <AlertDescription className="text-warning/80">
            Anyone with this token can send heartbeats and read-only commands
            against your account. Live trading remains BLOCKED, auto-close is
            ALERT_ONLY, and MT5 commands are force-BLOCKED — but the token
            should still be treated as a personal secret.
          </AlertDescription>
        </Alert>

        {loading && <div className="text-sm text-muted-foreground">Loading your connections…</div>}

        {!loading && activeConns.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <EyeOff className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
            <p className="font-medium">No per-user bridge token yet</p>
            <p className="text-sm text-muted-foreground">
              Create a connection to receive a token to paste into your EA's <code>BridgeToken</code> input.
            </p>
          </div>
        )}

        {activeConns.map((c) => (
          <div key={c.id} className="border rounded-lg p-3 space-y-2" data-testid={`row-per-user-conn-${c.id}`}>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="font-medium">{c.connectionName || `Connection #${c.id}`}</div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">{c.status}</Badge>
                <Badge variant="outline" className="font-mono">
                  Token …{c.tokenLast4 ?? "????"}
                </Badge>
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              Created {c.tokenCreatedAt ? new Date(c.tokenCreatedAt).toLocaleString() : "—"} · live_locked={String(c.liveLocked)} · read_only={String(c.readOnlyMode)} · allow_order_execution={String(c.allowOrderExecution)}
            </div>
            <div className="text-xs text-muted-foreground">
              Full token value cannot be retrieved after creation. If you lost it, regenerate to receive a new one (the old token stops working immediately).
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={() => regenerate(c.id)} data-testid={`button-regenerate-${c.id}`}>
                <RefreshCw className="w-3 h-3 mr-1" /> Regenerate &amp; reveal new token
              </Button>
              <Button size="sm" variant="outline" onClick={() => revoke(c.id)} data-testid={`button-revoke-${c.id}`}>
                Revoke
              </Button>
            </div>
          </div>
        ))}
      </CardContent>

      {/* Create dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create per-user bridge token</DialogTitle>
            <DialogDescription>
              You will be shown the new token exactly once. Save it before closing the dialog.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="conn-name">Connection name</Label>
            <Input
              id="conn-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. VPS — Demo MT5"
              data-testid="input-conn-name"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={createConn} disabled={!newName.trim()} data-testid="button-confirm-create">
              Generate token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reveal-once dialog */}
      <Dialog open={!!revealed} onOpenChange={(o) => !o && setRevealed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="w-5 h-5" />
              Per-user bridge token — paste into MT5 EA Inputs → BridgeToken
            </DialogTitle>
            <DialogDescription>
              Shown once. Copy now and paste into your MT5 EA's <code>BridgeToken</code> input. It cannot be retrieved later.
            </DialogDescription>
          </DialogHeader>
          {revealed && (
            <div className="space-y-3">
              <div
                className="font-mono text-sm bg-muted p-3 rounded break-all select-all"
                data-testid="text-revealed-token"
              >
                {revealed.raw}
              </div>
              <Button onClick={copyToken} data-testid="button-copy-revealed-token">
                <Copy className="w-3 h-3 mr-1" /> Copy token
              </Button>
              <Alert className="border-warning/40 bg-warning/10">
                <AlertTriangle className="h-4 w-4 text-warning" />
                <AlertTitle className="text-warning">Do not screenshot or share this token.</AlertTitle>
                <AlertDescription className="text-warning/80">
                  Keep it in a password manager. Anyone with this token can act
                  as your EA against this account.
                </AlertDescription>
              </Alert>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setRevealed(null)} data-testid="button-dismiss-token">
              I've saved it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

type DemoReadinessCheck = { key: string; status: "PASS" | "FAIL" | "INFO" | "WARN"; detail: string };
type DemoReadinessResponse = {
  status: "VERIFIED_DEMO" | "NOT_READY";
  headline: string;
  blockers: string[];
  checks: DemoReadinessCheck[];
  canArmExecution: boolean;
  canArmExecutionReason: string;
  executionMode: string;
  evidence: {
    accountTypeReported?: string;
    accountTypeExplicit?: boolean;
    serverNameHintsDemo?: boolean;
    heartbeatAgeSeconds?: number | null;
    eaVersion?: string | null;
    selectedBridgeConnectionId?: number | null;
    selectedLastHeartbeatAt?: string | null;
    selectedHeartbeatFresh?: boolean;
    selectedEaVersion?: string | null;
    selectedAccountType?: string | null;
    selectedAccountLoginMasked?: string | null;
    ignoredOlderConnectionsCount?: number;
    ignoredOlderConnectionsReason?: string | null;
  };
  safetyGateSnapshot: { liveLocked: boolean; allowOrderExecution: boolean; commandExecutionAllowed: boolean; brokerPlacementImplemented: boolean; executionPathsBuilt: boolean; autoCloseMode: string; sharedMt5RoutingBlocked: boolean };
};

function DemoExecutionReadinessCard() {
  const [data, setData] = useState<DemoReadinessResponse | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const r = await jget<DemoReadinessResponse>("/api/me/demo-execution-readiness");
      if (!cancelled) { setData(r); setLoading(false); }
    }
    void load();
    const t = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  const ready = data?.status === "VERIFIED_DEMO";
  const border = ready ? "border-success/40 bg-success/5" : "border-border bg-secondary/5";
  return (
    <Card className={`border-2 ${border}`} data-testid="card-demo-execution-readiness">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="w-4 h-4" /> Demo Execution Readiness
        </CardTitle>
        <CardDescription>
          Foundation gate (Phase 28-MT5-DEMO-FOUNDATION). Read-only. Execution paths are NOT implemented in this build — even VERIFIED_DEMO does not arm anything.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {loading && <p className="text-muted-foreground">Loading…</p>}
        {data && (
          <>
            <p data-testid="text-demo-headline" className="font-medium">{data.headline}</p>
            <div className="text-xs text-muted-foreground">
              executionMode=<code>{data.executionMode}</code> · canArmExecution=<code>{String(data.canArmExecution)}</code> ({data.canArmExecutionReason})
            </div>
            {data.evidence.selectedBridgeConnectionId != null && (
              <div className="text-xs border border-border rounded p-2 bg-card" data-testid="block-selected-bridge">
                <div className="font-medium text-txt-secondary mb-1">Evaluating bridge connection</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
                  <div>id: <code data-testid="text-selected-bridge-id">#{data.evidence.selectedBridgeConnectionId}</code></div>
                  <div>account: <code>{data.evidence.selectedAccountLoginMasked ?? "—"}</code></div>
                  <div>EA version: <code data-testid="text-selected-ea-version">{data.evidence.selectedEaVersion ?? "—"}</code></div>
                  <div>accountType: <code data-testid="text-selected-account-type">{data.evidence.selectedAccountType ?? "—"}</code></div>
                  <div>last heartbeat: <code>{data.evidence.selectedLastHeartbeatAt ?? "—"}</code></div>
                  <div>fresh: <code>{String(data.evidence.selectedHeartbeatFresh ?? false)}</code></div>
                </div>
                {(data.evidence.ignoredOlderConnectionsCount ?? 0) > 0 && (
                  <div className="mt-1 text-warning/80" data-testid="text-ignored-older">
                    {data.evidence.ignoredOlderConnectionsReason}
                  </div>
                )}
              </div>
            )}
            {data.blockers.length > 0 && (
              <div className="text-xs">
                <span className="text-warning font-medium">Blockers:</span> {data.blockers.join(", ")}
              </div>
            )}
            <ul className="text-xs space-y-1 mt-2">
              {data.checks.map(c => (
                <li key={c.key} className="flex gap-2">
                  <span className={
                    c.status === "PASS" ? "text-success" :
                    c.status === "FAIL" ? "text-danger" :
                    c.status === "WARN" ? "text-warning" :
                    "text-txt-secondary"
                  }>[{c.status}]</span>
                  <span className="text-muted-foreground"><code>{c.key}</code> — {c.detail}</span>
                </li>
              ))}
            </ul>
            <div className="text-xs text-muted-foreground pt-2 border-t border-border/50 mt-2">
              Envelope: liveLocked={String(data.safetyGateSnapshot.liveLocked)} · allowOrderExecution={String(data.safetyGateSnapshot.allowOrderExecution)} · executionPathsBuilt={String(data.safetyGateSnapshot.executionPathsBuilt)} · autoClose={data.safetyGateSnapshot.autoCloseMode} · sharedRoutingBlocked={String(data.safetyGateSnapshot.sharedMt5RoutingBlocked)}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

type DemoExecutionStatusResponse = {
  mode: "PAPER" | "MT5_DEMO_READ_ONLY" | "MT5_DEMO_EXECUTION" | "LIVE_LOCKED";
  armed: boolean;
  armedAt: string | null;
  disarmedAt: string | null;
  disarmedReason: string | null;
  readiness: DemoReadinessResponse;
  canDispatchToMt5: boolean;
  canDispatchToMt5Reason: string;
};

async function jpost<T>(url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await r.json().catch(() => null)) as T | null;
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

function DemoExecutionControlCard() {
  const { toast } = useToast();
  const [data, setData] = useState<DemoExecutionStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    const r = await jget<DemoExecutionStatusResponse>("/api/me/demo-execution/status");
    setData(r);
    setLoading(false);
  }
  useEffect(() => {
    void load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  async function arm() {
    setBusy(true);
    const r = await jpost<{ ok: boolean; refusalReason?: string }>("/api/me/demo-execution/arm");
    setBusy(false);
    if (r.ok && r.data?.ok) {
      toast({ title: "Demo execution ARMED", description: "Broker dispatch remains structurally disabled in this build." });
    } else {
      toast({ title: "Arm refused", description: r.data?.refusalReason ?? `HTTP ${r.status}` });
    }
    void load();
  }
  async function disarm() {
    setBusy(true);
    const r = await jpost("/api/me/demo-execution/disarm", { reason: "manual_disarm_from_setup" });
    setBusy(false);
    if (r.ok) toast({ title: "Demo execution DISARMED" });
    void load();
  }

  const armed = data?.armed === true;
  const canArm = data?.readiness.canArmExecution === true;
  const border = armed
    ? "border-primary/40 bg-primary/5"
    : canArm
      ? "border-warning/40 bg-warning/5"
      : "border-border bg-secondary/5";

  return (
    <Card className={`border-2 ${border}`} data-testid="card-demo-execution-control">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="w-4 h-4" /> Demo Execution Control
        </CardTitle>
        <CardDescription>
          Phase 28-MT5-DEMO-ARMING. Arming unlocks the per-user demo command queue and the EA v1.26 demo
          dispatch path. <strong>Live trading remains BLOCKED.</strong> All dispatches re-check the per-user
          gate (VERIFIED_DEMO, account_type=demo, EA v1.26, fresh heartbeat, risk/duplicate) before
          touching MT5.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {loading && <p className="text-muted-foreground">Loading…</p>}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={armed ? "default" : "secondary"} data-testid="badge-demo-exec-mode">
                mode: {data.mode === "PAPER" ? "DEMO" : data.mode}
              </Badge>
              <Badge variant={canArm ? "default" : "outline"}>
                canArmExecution: {String(canArm)}
              </Badge>
              <Badge variant={data.canDispatchToMt5 ? "default" : "outline"} data-testid="badge-can-dispatch">
                canDispatchToMt5: {String(data.canDispatchToMt5)}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground">
              {armed
                ? `Armed at ${data.armedAt ?? "?"}. Use the Demo Execution Test Panel below to draft and dispatch a demo order. Each dispatch re-runs the per-user gate.`
                : `Not armed. ${canArm ? "Click Arm Demo Execution to enable the demo command queue." : `Arming is blocked: ${data.readiness.canArmExecutionReason}`}`}
            </div>
            <div className="text-xs">
              Dispatch status: <code>{data.canDispatchToMt5 ? "ELIGIBLE" : data.canDispatchToMt5Reason}</code>
            </div>
            <div className="flex gap-2 pt-2">
              <Button
                onClick={arm}
                disabled={busy || armed || !canArm}
                data-testid="button-arm-demo-execution"
              >
                Arm Demo Execution
              </Button>
              <Button
                variant="destructive"
                onClick={disarm}
                disabled={busy || !armed}
                data-testid="button-disarm-demo-execution"
              >
                Emergency Disarm
              </Button>
            </div>
            <Alert className="border-warning/40 bg-warning/10">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertTitle className="text-warning">DEMO ONLY — live trading remains locked.</AlertTitle>
              <AlertDescription className="text-warning/80 text-xs">
                Arming enables the per-user demo command queue and the EA v1.26 dispatch path. Any dispatched
                order is sent only to your MT5 DEMO account after the per-user gate re-validates
                VERIFIED_DEMO, accountType=demo, EA v1.26, heartbeat freshness, and risk/duplicate checks.
                Live trading, shared MT5 routing, and live auto-close remain BLOCKED.
              </AlertDescription>
            </Alert>
          </>
        )}
      </CardContent>
    </Card>
  );
}

type DemoCommandRow = {
  id: number;
  commandId: string;
  commandType: string;
  status: string;
  payload: Record<string, unknown> | null;
  reason: string | null;
  brokerOrderId: string | null;
  brokerTicket: string | null;
  fillPrice: string | number | null;
  fillVolume: string | number | null;
  createdAt: string | null;
  approvedAt: string | null;
  sentAt?: string | null;
  filledAt?: string | null;
  terminalAt?: string | null;
};

type DemoCommandsListResponse = { items: DemoCommandRow[]; count: number };

// Canonical lifecycle statuses stored in mt5_demo_commands.status:
//   DRAFT, USER_CONFIRMATION_REQUIRED, DEMO_APPROVED, SENT_TO_MT5_DEMO,
//   FILLED_DEMO, REJECTED, FAILED, BLOCKED
// Legacy/alias values are also recognized so this UI is robust to either form.
const TERMINAL_STATUSES = new Set([
  "FILLED_DEMO", "MT5_DEMO_FILLED", "DEMO_FILLED",
  "REJECTED",    "MT5_DEMO_REJECTED", "DEMO_REJECTED",
  "FAILED",      "DEMO_FAILED",
  "BLOCKED",     "DEMO_CANCELLED",
]);

type NormalizedStatus =
  | "FILLED" | "REJECTED" | "FAILED" | "BLOCKED" | "CANCELLED" | "PENDING";

function normalizeStatus(s: string | null | undefined): NormalizedStatus {
  const x = String(s ?? "").toUpperCase();
  if (x === "FILLED_DEMO" || x === "MT5_DEMO_FILLED" || x === "DEMO_FILLED") return "FILLED";
  if (x === "REJECTED" || x === "MT5_DEMO_REJECTED" || x === "DEMO_REJECTED") return "REJECTED";
  if (x === "FAILED" || x === "DEMO_FAILED") return "FAILED";
  if (x === "BLOCKED") return "BLOCKED";
  if (x === "DEMO_CANCELLED") return "CANCELLED";
  return "PENDING";
}

function statusBadgeClass(s: string): string {
  switch (normalizeStatus(s)) {
    case "FILLED":    return "bg-success/15 text-success border-success/30";
    case "REJECTED":
    case "FAILED":    return "bg-danger/15 text-danger border-danger/30";
    case "BLOCKED":
    case "CANCELLED": return "bg-secondary/15 text-txt-secondary border-border";
    default:
      if (s === "SENT_TO_MT5_DEMO") return "bg-primary/15 text-primary border-primary/30";
      if (s === "DEMO_APPROVED")    return "bg-warning/15 text-warning border-warning/30";
      return "bg-secondary/15 text-txt-secondary border-border";
  }
}

// Surface the most informative reason source: server reason, broker code,
// or an explicit fallback so rejected/failed rows never display as blank.
function bestReason(c: DemoCommandRow): string {
  if (c.reason && c.reason.trim()) return c.reason;
  const n = normalizeStatus(c.status);
  if (n === "REJECTED") return "REJECTED (no reason reported by EA/broker)";
  if (n === "FAILED")   return "FAILED (no reason reported)";
  if (n === "BLOCKED" || n === "CANCELLED") return "Cancelled by user or guard";
  return "";
}

type DemoOpenPosition = {
  brokerTicket: string | null;
  symbol: string | null;
  side: string | null;
  volume: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  floatingPnL: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: string | null;
  sourceCommandId: string | null;
  matchStatus: "MATCHED_TO_ARX_COMMAND" | "ORPHAN_MT5_POSITION";
};
type DemoPositionsSnapshot = {
  ok: boolean;
  lastSyncAt: string | null;
  openPositions: DemoOpenPosition[];
  reconciliation: {
    mt5OpenPositionCount: number;
    arxMatchedPositionCount: number;
    arxOrphanPositionCount: number;
    filledCommandHistoryCount: number;
    inSync: boolean;
  };
};

function OpenDemoPositionsCard() {
  const { toast } = useToast();
  const [snap, setSnap] = useState<DemoPositionsSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    const s = await jget<DemoPositionsSnapshot>("/api/me/demo-positions-snapshot");
    setSnap(s);
    setRefreshing(false);
  }
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const positions = snap?.openPositions ?? [];
  const recon = snap?.reconciliation;
  const orphanCount = recon?.arxOrphanPositionCount ?? 0;
  const lastSync = snap?.lastSyncAt ? new Date(snap.lastSyncAt) : null;
  const ageSec = lastSync ? Math.round((Date.now() - lastSync.getTime()) / 1000) : null;
  const stale = ageSec != null && ageSec > 30;

  return (
    <Card className="border-2 border-success/30 bg-success/5" data-testid="card-open-demo-positions">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="w-4 h-4" /> Open Demo Positions (MT5)
        </CardTitle>
        <CardDescription>
          Live snapshot of every open position on your MT5 DEMO account, joined to ARX demo
          commands by broker ticket. Your EA syncs this every few seconds.{" "}
          <strong>DEMO ONLY.</strong>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <Badge variant="outline" data-testid="badge-open-positions-count">
            MT5 open: {recon?.mt5OpenPositionCount ?? 0}
          </Badge>
          <Badge variant="outline">ARX matched: {recon?.arxMatchedPositionCount ?? 0}</Badge>
          <Badge
            className={
              orphanCount > 0
                ? "bg-warning/15 text-warning border-warning/30"
                : "bg-success/15 text-success border-success/30"
            }
            data-testid="badge-open-positions-orphans"
          >
            Orphan (not from ARX): {orphanCount}
          </Badge>
          <Badge variant="outline">ARX fill history: {recon?.filledCommandHistoryCount ?? 0}</Badge>
          <span className="text-muted-foreground">
            Last sync: {lastSync ? `${ageSec}s ago` : "never"}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load().then(() => toast({ title: "Positions snapshot refreshed" }))}
            disabled={refreshing}
            data-testid="button-refresh-open-positions"
          >
            <RefreshCw className={`w-3 h-3 mr-1 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>

        {stale && (
          <Alert className="border-warning/40 bg-warning/10">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <AlertTitle className="text-warning">Positions snapshot is stale</AlertTitle>
            <AlertDescription className="text-warning/80 text-xs">
              The EA has not posted a positions sync in {ageSec}s. Check that the EA is attached,
              accountType=demo, and the bridge token is valid.
            </AlertDescription>
          </Alert>
        )}

        {orphanCount > 0 && (
          <Alert className="border-warning/40 bg-warning/10">
            <AlertTriangle className="h-4 w-4 text-warning" />
            <AlertTitle className="text-warning">
              {orphanCount} open MT5 position(s) not tracked by ARX
            </AlertTitle>
            <AlertDescription className="text-warning/80 text-xs">
              These positions exist on your DEMO account but were not opened through ARX —
              likely opened manually in MT5 or by another script. They are shown for transparency
              but cannot be closed from ARX.
            </AlertDescription>
          </Alert>
        )}

        {positions.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No open positions on the MT5 demo account.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="table-open-demo-positions">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-1 pr-2">Ticket</th>
                  <th className="text-left py-1 pr-2">Symbol</th>
                  <th className="text-left py-1 pr-2">Side</th>
                  <th className="text-left py-1 pr-2">Vol</th>
                  <th className="text-left py-1 pr-2">Entry</th>
                  <th className="text-left py-1 pr-2">P&L</th>
                  <th className="text-left py-1 pr-2">SL / TP</th>
                  <th className="text-left py-1 pr-2">Source</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => {
                  const matched = p.matchStatus === "MATCHED_TO_ARX_COMMAND";
                  const pnl = p.floatingPnL ?? 0;
                  return (
                    <tr
                      key={p.brokerTicket ?? `pos-${i}`}
                      className="border-b border-border"
                      data-testid={`row-open-position-${p.brokerTicket ?? i}`}
                    >
                      <td className="py-1 pr-2 font-mono text-[10px]">{p.brokerTicket ?? "—"}</td>
                      <td className="py-1 pr-2">{p.symbol ?? "—"}</td>
                      <td className="py-1 pr-2">{p.side ?? "—"}</td>
                      <td className="py-1 pr-2">{p.volume ?? "—"}</td>
                      <td className="py-1 pr-2 font-mono text-[10px]">{p.entryPrice ?? "—"}</td>
                      <td className={`py-1 pr-2 font-mono text-[10px] ${pnl >= 0 ? "text-success" : "text-danger"}`}>
                        {pnl.toFixed(2)}
                      </td>
                      <td className="py-1 pr-2 font-mono text-[10px]">
                        {(p.stopLoss ?? 0)} / {(p.takeProfit ?? 0)}
                      </td>
                      <td className="py-1 pr-2">
                        {matched ? (
                          <Badge className="bg-success/15 text-success border-success/30">
                            ARX
                          </Badge>
                        ) : (
                          <Badge className="bg-warning/15 text-warning border-warning/30">
                            Orphan
                          </Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DemoExecutionTestPanelCard() {
  const { toast } = useToast();
  const [status, setStatus] = useState<DemoExecutionStatusResponse | null>(null);
  const [commands, setCommands] = useState<DemoCommandRow[]>([]);
  const [busy, setBusy] = useState(false);
  // Track the most recently dispatched command so we can surface its terminal
  // outcome (FILLED / REJECTED / FAILED / BLOCKED) as a Latest Result card +
  // toast even if the user has scrolled or the row has moved.
  const [lastDispatchedId, setLastDispatchedId] = useState<string | null>(null);
  const [notifiedTerminal, setNotifiedTerminal] = useState<Set<string>>(new Set());

  // Draft form
  const [symbol, setSymbol] = useState("EURUSD");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [volume, setVolume] = useState("0.01");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");

  // Confirm + dispatch modal
  const [pendingDraft, setPendingDraft] = useState<DemoCommandRow | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  async function refresh() {
    const [s, c] = await Promise.all([
      jget<DemoExecutionStatusResponse>("/api/me/demo-execution/status"),
      jget<DemoCommandsListResponse>("/api/me/demo-commands?limit=50"),
    ]);
    setStatus(s);
    setCommands(c?.items ?? []);
  }
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  // Surface a toast the first time the most-recently-dispatched command
  // reaches a terminal status. Guarded by notifiedTerminal so we toast
  // exactly once per command id.
  const lastDispatched = lastDispatchedId
    ? commands.find((c) => c.commandId === lastDispatchedId) ?? null
    : null;
  useEffect(() => {
    if (!lastDispatched) return;
    if (!TERMINAL_STATUSES.has(lastDispatched.status)) return;
    if (notifiedTerminal.has(lastDispatched.commandId)) return;
    const n = normalizeStatus(lastDispatched.status);
    const reason = bestReason(lastDispatched);
    const tkt = lastDispatched.brokerTicket ?? lastDispatched.brokerOrderId ?? "";
    toast({
      title:
        n === "FILLED"   ? `Demo order FILLED${tkt ? ` (ticket ${tkt})` : ""}` :
        n === "REJECTED" ? "Demo order REJECTED by EA / broker" :
        n === "FAILED"   ? "Demo order FAILED" :
                           "Demo order finalized",
      description: reason || `Command ${lastDispatched.commandId.slice(0, 12)}…`,
    });
    setNotifiedTerminal((prev) => {
      const next = new Set(prev);
      next.add(lastDispatched.commandId);
      return next;
    });
  }, [lastDispatched, notifiedTerminal, toast]);

  const armed = status?.armed === true;
  const canDispatch = status?.canDispatchToMt5 === true;
  const readiness = status?.readiness;
  const bridgeOk =
    readiness?.checks?.find((x) => x.key === "user_owns_bridge")?.status === "PASS";
  const accountTypeOk =
    readiness?.checks?.find((x) => x.key === "account_type_explicit_demo")?.status === "PASS";
  const verifiedDemo = readiness?.status === "VERIFIED_DEMO";
  // `canDispatch` is always false at status time because the gate is evaluated
  // with userConfirmed:false. If USER_NOT_CONFIRMED is the only blocker, the
  // command is dispatchable as soon as the user confirms in the modal — the
  // server re-runs the full gate with userConfirmed:true on POST /dispatch.
  const dispatchableModuloConfirm = (() => {
    if (canDispatch) return true;
    const r = status?.canDispatchToMt5Reason ?? "";
    if (!/USER_NOT_CONFIRMED/.test(r)) return false;
    if (/ACCOUNT_TYPE|BRIDGE|HEARTBEAT|EA_VERSION|VERIFIED|ARMED|LIVE_LOCKED|DUPLICATE|RISK/.test(r)) return false;
    return armed && verifiedDemo && bridgeOk && accountTypeOk;
  })();

  function validDraft(): string | null {
    if (!armed) return "Arm Demo Execution first.";
    if (!verifiedDemo) return "Demo verification has not passed yet.";
    if (!bridgeOk) return "Bridge connection not detected.";
    if (!accountTypeOk) return "EA has not reported accountType=demo yet.";
    // NOTE: We deliberately do NOT block drafting on `canDispatch`. The
    // dispatch gate's `USER_NOT_CONFIRMED` blocker is expected at status
    // time — confirmation happens inside the dispatch modal AFTER draft.
    // The server re-evaluates the full dispatch gate on POST /dispatch.
    if (!symbol.trim()) return "Symbol required.";
    const v = Number(volume);
    if (!Number.isFinite(v) || v < 0.01) return "Volume must be ≥ 0.01.";
    if (stopLoss && !Number.isFinite(Number(stopLoss))) return "Stop loss must be a number.";
    if (takeProfit && !Number.isFinite(Number(takeProfit))) return "Take profit must be a number.";
    return null;
  }

  async function draftOrder() {
    const err = validDraft();
    if (err) { toast({ title: "Cannot draft", description: err }); return; }
    setBusy(true);
    const payload: Record<string, unknown> = {
      symbol: symbol.trim().toUpperCase(),
      side,
      volume: Number(volume),
    };
    if (stopLoss) payload.stopLoss = Number(stopLoss);
    if (takeProfit) payload.takeProfit = Number(takeProfit);
    const r = await jpost<{ command?: DemoCommandRow; error?: string; reason?: string }>(
      "/api/me/demo-commands",
      { commandType: "PLACE_MARKET_ORDER", payload },
    );
    setBusy(false);
    if (r.ok && r.data?.command) {
      setPendingDraft(r.data.command);
      setAcknowledged(false);
      void refresh();
    } else {
      toast({
        title: "Draft refused",
        description: r.data?.reason ?? r.data?.error ?? `HTTP ${r.status}`,
      });
    }
  }

  async function confirmAndDispatch() {
    if (!pendingDraft) return;
    if (!acknowledged) { toast({ title: "Please acknowledge the demo notice." }); return; }
    setBusy(true);
    const cfm = await jpost<{ ok?: boolean; error?: string; reason?: string }>(
      `/api/me/demo-commands/${pendingDraft.commandId}/confirm`,
    );
    if (!cfm.ok) {
      setBusy(false);
      toast({
        title: "Confirm refused",
        description: cfm.data?.reason ?? cfm.data?.error ?? `HTTP ${cfm.status}`,
      });
      return;
    }
    const dsp = await jpost<{ ok?: boolean; reason?: string; error?: string; command?: DemoCommandRow }>(
      `/api/me/demo-commands/${pendingDraft.commandId}/dispatch`,
    );
    setBusy(false);
    if (dsp.ok) {
      setLastDispatchedId(pendingDraft.commandId);
      toast({
        title: "Queued for MT5 DEMO pickup",
        description: `Command ${pendingDraft.commandId.slice(0, 12)}… is in SENT_TO_MT5_DEMO. The EA will poll and execute only if EnableDemoExecution=true, ReadOnlyMode=false, and the account is DEMO. You'll see a toast and the Latest Result card update on fill or rejection.`,
      });
    } else {
      toast({
        title: "Dispatch refused",
        description: dsp.data?.reason ?? dsp.data?.error ?? `HTTP ${dsp.status}`,
      });
    }
    setPendingDraft(null);
    setAcknowledged(false);
    void refresh();
  }

  async function cancelPending() {
    if (!pendingDraft) return;
    setBusy(true);
    await jpost(`/api/me/demo-commands/${pendingDraft.commandId}/cancel`, { reason: "user_cancelled_in_modal" });
    setBusy(false);
    setPendingDraft(null);
    setAcknowledged(false);
    void refresh();
  }

  async function closePosition(positionTicket: string) {
    setBusy(true);
    const r = await jpost<{ command?: DemoCommandRow; reason?: string; error?: string }>(
      "/api/me/demo-commands",
      { commandType: "CLOSE_POSITION", payload: { positionTicket } },
    );
    setBusy(false);
    if (r.ok && r.data?.command) {
      setPendingDraft(r.data.command);
      setAcknowledged(false);
      void refresh();
    } else {
      toast({ title: "Close draft refused", description: r.data?.reason ?? r.data?.error ?? `HTTP ${r.status}` });
    }
  }

  const validationMsg = validDraft();
  const draftButtonDisabled = busy || validationMsg !== null;

  return (
    <Card className="border-2 border-primary/30 bg-primary/5" data-testid="card-demo-execution-test-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="w-4 h-4" /> Demo Execution Test Panel
        </CardTitle>
        <CardDescription>
          Owner/operator controlled test of the end-to-end demo dispatch flow: arm → draft → confirm → dispatch → reconcile.
          Every dispatch re-runs the per-user gate (VERIFIED_DEMO, account_type=demo, EA v1.26, heartbeat, risk, duplicate).
          <strong> DEMO ONLY — live trading remains locked.</strong>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/* Gate badges */}
        <div className="flex flex-wrap gap-2">
          <Badge variant={armed ? "default" : "outline"} data-testid="badge-tp-armed">armed: {String(armed)}</Badge>
          <Badge variant={verifiedDemo ? "default" : "outline"}>verifiedDemo: {String(verifiedDemo)}</Badge>
          <Badge variant={bridgeOk ? "default" : "outline"}>bridge: {bridgeOk ? "OK" : "MISSING"}</Badge>
          <Badge variant={accountTypeOk ? "default" : "outline"}>accountType=demo: {accountTypeOk ? "OK" : "NO"}</Badge>
          <Badge variant={canDispatch ? "default" : "outline"} data-testid="badge-tp-can-dispatch">
            canDispatch: {String(canDispatch)}
          </Badge>
        </div>

        {/* Draft form */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div>
            <Label htmlFor="tp-symbol" className="text-xs">Symbol</Label>
            <Input
              id="tp-symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              data-testid="input-tp-symbol"
            />
          </div>
          <div>
            <Label className="text-xs">Side</Label>
            <div className="flex gap-1 pt-1">
              <Button
                size="sm"
                variant={side === "BUY" ? "default" : "outline"}
                onClick={() => setSide("BUY")}
                data-testid="button-tp-side-buy"
              >BUY</Button>
              <Button
                size="sm"
                variant={side === "SELL" ? "default" : "outline"}
                onClick={() => setSide("SELL")}
                data-testid="button-tp-side-sell"
              >SELL</Button>
            </div>
          </div>
          <div>
            <Label htmlFor="tp-volume" className="text-xs">Volume (lots)</Label>
            <Input
              id="tp-volume"
              type="number"
              min="0.01"
              step="0.01"
              value={volume}
              onChange={(e) => setVolume(e.target.value)}
              data-testid="input-tp-volume"
            />
          </div>
          <div>
            <Label htmlFor="tp-sl" className="text-xs">Stop loss (optional)</Label>
            <Input
              id="tp-sl"
              type="number"
              step="0.00001"
              value={stopLoss}
              onChange={(e) => setStopLoss(e.target.value)}
              data-testid="input-tp-sl"
            />
          </div>
          <div>
            <Label htmlFor="tp-tp" className="text-xs">Take profit (optional)</Label>
            <Input
              id="tp-tp"
              type="number"
              step="0.00001"
              value={takeProfit}
              onChange={(e) => setTakeProfit(e.target.value)}
              data-testid="input-tp-tp"
            />
          </div>
        </div>

        {validationMsg && (
          <p className="text-xs text-warning" data-testid="text-tp-validation">{validationMsg}</p>
        )}

        <div className="flex gap-2">
          <Button
            onClick={draftOrder}
            disabled={draftButtonDisabled}
            data-testid="button-tp-draft"
          >
            <Plus className="w-4 h-4 mr-1" /> Draft demo order
          </Button>
          <Button variant="outline" onClick={() => void refresh()} disabled={busy} data-testid="button-tp-refresh">
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh
          </Button>
        </div>

        <Alert className="border-warning/40 bg-warning/10">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle className="text-warning">DEMO ONLY — live trading remains locked.</AlertTitle>
          <AlertDescription className="text-warning/80 text-xs">
            Drafts will not dispatch until you click Confirm in the modal. Every dispatch re-runs the per-user
            gate server-side; if accountType ≠ demo or EA &lt; v1.26, the dispatch is rejected before MT5 is touched.
          </AlertDescription>
        </Alert>

        {/* Latest Demo Trade Result */}
        {lastDispatched && (() => {
          const n = normalizeStatus(lastDispatched.status);
          const tkt = lastDispatched.brokerTicket ?? lastDispatched.brokerOrderId ?? "";
          const p = (lastDispatched.payload ?? {}) as Record<string, unknown>;
          const tone =
            n === "FILLED" ? "border-success/40 bg-success/10" :
            n === "REJECTED" || n === "FAILED" ? "border-danger/40 bg-danger/10" :
            n === "BLOCKED" || n === "CANCELLED" ? "border-border bg-secondary/10" :
                                                   "border-primary/40 bg-primary/10";
          return (
            <div
              className={`rounded-md border ${tone} p-3 text-xs space-y-1`}
              data-testid="card-tp-latest-result"
            >
              <div className="flex items-center justify-between">
                <strong>Latest demo trade result</strong>
                <Badge className={statusBadgeClass(lastDispatched.status)}>
                  {lastDispatched.status}
                </Badge>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1">
                <div><span className="text-muted-foreground">Command:</span> <span className="font-mono">{lastDispatched.commandId.slice(0, 12)}…</span></div>
                <div><span className="text-muted-foreground">Type:</span> {lastDispatched.commandType}</div>
                <div><span className="text-muted-foreground">Symbol:</span> {String(p.symbol ?? "—")}</div>
                <div><span className="text-muted-foreground">Side:</span> {String(p.side ?? "—")}</div>
                <div><span className="text-muted-foreground">Volume:</span> {String(p.volume ?? "—")}</div>
                <div><span className="text-muted-foreground">Broker ticket:</span> <span className="font-mono">{tkt || "—"}</span></div>
                <div><span className="text-muted-foreground">Fill price:</span> {lastDispatched.fillPrice ?? "—"}</div>
                <div><span className="text-muted-foreground">Fill volume:</span> {lastDispatched.fillVolume ?? "—"}</div>
              </div>
              {(n === "REJECTED" || n === "FAILED" || n === "BLOCKED" || n === "CANCELLED") && (
                <div className="text-warning">Reason: {bestReason(lastDispatched)}</div>
              )}
            </div>
          );
        })()}

        {/* Commands table */}
        <div>
          <p className="text-xs text-muted-foreground mb-2">Recent demo commands (last 50)</p>
          {commands.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No demo commands yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-tp-commands">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="text-left py-1 pr-2">ID</th>
                    <th className="text-left py-1 pr-2">Type</th>
                    <th className="text-left py-1 pr-2">Status</th>
                    <th className="text-left py-1 pr-2">Symbol / Side / Vol</th>
                    <th className="text-left py-1 pr-2">Broker</th>
                    <th className="text-left py-1 pr-2">Fill</th>
                    <th className="text-left py-1 pr-2">Reason</th>
                    <th className="text-left py-1 pr-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {commands.map((c) => {
                    const p = (c.payload ?? {}) as Record<string, unknown>;
                    const sym = String(p.symbol ?? "");
                    const sd = String(p.side ?? "");
                    const vol = p.volume == null ? "" : String(p.volume);
                    const tkt = c.brokerTicket ?? c.brokerOrderId ?? "";
                    const fill =
                      c.fillPrice != null
                        ? `${c.fillPrice}${c.fillVolume != null ? ` @ ${c.fillVolume}` : ""}`
                        : "";
                    const isFilled = normalizeStatus(c.status) === "FILLED" && c.commandType === "PLACE_MARKET_ORDER";
                    return (
                      <tr key={c.id} className="border-b border-border" data-testid={`row-tp-cmd-${c.id}`}>
                        <td className="py-1 pr-2 font-mono text-[10px]" title={c.commandId}>{c.commandId.slice(0, 12)}</td>
                        <td className="py-1 pr-2">{c.commandType}</td>
                        <td className="py-1 pr-2">
                          <Badge className={statusBadgeClass(c.status)} data-testid={`badge-tp-status-${c.id}`}>
                            {c.status}
                          </Badge>
                        </td>
                        <td className="py-1 pr-2">{sym} {sd} {vol}</td>
                        <td className="py-1 pr-2 font-mono text-[10px]">{tkt}</td>
                        <td className="py-1 pr-2 font-mono text-[10px]">{fill}</td>
                        <td className="py-1 pr-2 text-warning text-[10px]" title={bestReason(c)}>{bestReason(c)}</td>
                        <td className="py-1 pr-2">
                          {isFilled && tkt ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void closePosition(tkt)}
                              disabled={busy}
                              data-testid={`button-tp-close-${c.id}`}
                            >
                              Close
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground mt-2">
            Status polls every 3s. Terminal statuses ({Array.from(TERMINAL_STATUSES).join(", ")}) stop updating.
          </p>
        </div>
      </CardContent>

      {/* Confirmation modal */}
      <Dialog open={pendingDraft !== null} onOpenChange={(open) => { if (!open) { setPendingDraft(null); setAcknowledged(false); } }}>
        <DialogContent data-testid="dialog-tp-confirm">
          <DialogHeader>
            <DialogTitle>Confirm DEMO order dispatch</DialogTitle>
            <DialogDescription>
              Review every field. This dispatches the order to your MT5 DEMO account. Live trading remains BLOCKED.
            </DialogDescription>
          </DialogHeader>
          {pendingDraft && (() => {
            const p = (pendingDraft.payload ?? {}) as Record<string, unknown>;
            return (
              <div className="text-sm space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div><span className="text-muted-foreground">Command:</span> <strong>{pendingDraft.commandType}</strong></div>
                  <div><span className="text-muted-foreground">Symbol:</span> <strong data-testid="text-tp-confirm-symbol">{String(p.symbol ?? "—")}</strong></div>
                  <div><span className="text-muted-foreground">Direction:</span> <strong>{String(p.side ?? "—")}</strong></div>
                  <div><span className="text-muted-foreground">Volume:</span> <strong>{String(p.volume ?? "—")}</strong></div>
                  <div><span className="text-muted-foreground">Stop loss:</span> <strong>{p.stopLoss == null ? "—" : String(p.stopLoss)}</strong></div>
                  <div><span className="text-muted-foreground">Take profit:</span> <strong>{p.takeProfit == null ? "—" : String(p.takeProfit)}</strong></div>
                  <div><span className="text-muted-foreground">Order type:</span> <strong>Market</strong></div>
                  <div><span className="text-muted-foreground">Account mode:</span> <Badge>DEMO</Badge></div>
                  <div><span className="text-muted-foreground">Bridge:</span> <Badge variant={bridgeOk ? "default" : "outline"}>{bridgeOk ? "Connected" : "Missing"}</Badge></div>
                  <div><span className="text-muted-foreground">Demo verified:</span> <Badge variant={verifiedDemo ? "default" : "outline"}>{verifiedDemo ? "VERIFIED_DEMO" : readiness?.status ?? "—"}</Badge></div>
                </div>
                <div className="text-xs text-muted-foreground border-t border-border pt-2">
                  Per-user dispatch gate: <code>{
                    canDispatch
                      ? "ELIGIBLE"
                      : (() => {
                          const r = status?.canDispatchToMt5Reason ?? "—";
                          // The status-time gate always reports USER_NOT_CONFIRMED
                          // because no specific command is in hand. If that's the
                          // only blocker, the server will re-evaluate and approve
                          // when this dialog confirms.
                          if (/USER_NOT_CONFIRMED/.test(r)
                            && !/ACCOUNT_TYPE|BRIDGE|HEARTBEAT|EA_VERSION|VERIFIED|ARMED|LIVE/.test(r)) {
                            return "Awaiting your confirmation — all other checks pass.";
                          }
                          return r;
                        })()
                  }</code>
                </div>
                <label className="flex items-start gap-2 text-xs cursor-pointer pt-2">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                    data-testid="checkbox-tp-acknowledge"
                  />
                  <span>I understand this is a demo trade only. Live trading remains locked.</span>
                </label>
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={cancelPending} disabled={busy} data-testid="button-tp-cancel">Cancel</Button>
            <Button
              onClick={confirmAndDispatch}
              disabled={busy || !acknowledged || !dispatchableModuloConfirm}
              data-testid="button-tp-confirm-dispatch"
            >
              Confirm & Dispatch to DEMO
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

type DemoBridgeDebugResponse = {
  ok: boolean;
  bridge: {
    connectionId: number | null;
    accountLoginMasked: string | null;
    accountType: string | null;
    eaVersionReported: string | null;
    lastHeartbeatAt: string | null;
    heartbeatAgeSeconds: number | null;
    heartbeatFresh: boolean;
  };
  demoConsumer: {
    eaDemoConsumerActive: boolean;
    lastPollAt: string | null;
    lastPollAgeSeconds: number | null;
    lastPollOutcome: string | null;
    lastPollServedCount: number | null;
    lastDispatchSentAt: string | null;
    lastResultAt: string | null;
    lastResultOutcome: string | null;
    lastResultMessage: string | null;
  };
  pending: {
    sentToMt5DemoCount: number;
    pickupableByCurrentBridge: number;
    orphanedFromPreviousBridge: number;
    orphanedCommandIds: string[];
    earlyOrphanedCount?: number;
    earlyOrphanedCommandIds?: string[];
    totalOrphanedAnyState?: number;
    oldestSentAt: string | null;
  };
  lastTerminalCommand: {
    commandId: string;
    status: string;
    reason: string | null;
    brokerTicket: string | null;
    fillPrice: number | string | null;
    filledAt: string | null;
  } | null;
  diagnoses: string[];
};

function DemoBridgeDebugCard() {
  const { toast } = useToast();
  const [data, setData] = useState<DemoBridgeDebugResponse | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  async function load() {
    const r = await jget<DemoBridgeDebugResponse>("/api/me/demo-bridge-debug");
    setData(r);
  }
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  async function cancelOrphans() {
    setCancelBusy(true);
    const r = await jpost<{
      ok: boolean;
      cancelledCount: number;
      cancelledCommandIds: string[];
      reason: string | null;
    }>("/api/me/demo-commands/cancel-orphaned");
    setCancelBusy(false);
    if (r.ok && r.data?.ok) {
      toast({
        title: `Cancelled ${r.data.cancelledCount} orphaned demo command(s)`,
        description:
          r.data.cancelledCount > 0
            ? `Marked FAILED with reason EXPIRED_ORPHANED_BRIDGE_COMMAND: ${r.data.cancelledCommandIds.map((c) => c.slice(0, 14)).join(", ")}`
            : "No orphaned commands to cancel.",
      });
    } else {
      toast({
        title: "Cancel-orphaned refused",
        description: r.data?.reason ?? `HTTP ${r.status}`,
      });
    }
    void load();
  }

  if (!data) {
    return (
      <Card className="border-border" data-testid="card-demo-bridge-debug">
        <CardHeader><CardTitle className="text-base">Demo Bridge Debug</CardTitle></CardHeader>
        <CardContent className="text-sm text-txt-secondary">Loading…</CardContent>
      </Card>
    );
  }
  const consumerColor = data.demoConsumer.eaDemoConsumerActive
    ? "text-success"
    : data.pending.sentToMt5DemoCount > 0
    ? "text-danger"
    : "text-warning";
  return (
    <Card className="border-border" data-testid="card-demo-bridge-debug">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Plug className="w-4 h-4" /> Demo Bridge Debug
        </CardTitle>
        <CardDescription>
          What the EA is actually doing on the DEMO channel. Updates every 5s.
          Live trading remains BLOCKED.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {data.diagnoses.length > 0 && (
          <Alert variant="destructive" data-testid="alert-demo-bridge-diagnoses">
            <AlertTriangle className="w-4 h-4" />
            <AlertTitle>EA appears not to be picking up demo commands</AlertTitle>
            <AlertDescription>
              <ul className="list-disc ml-4 space-y-1">
                {data.diagnoses.map((d, i) => (
                  <li key={i} data-testid={`diagnosis-${i}`}>{d}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {(data.pending.orphanedFromPreviousBridge > 0 || (data.pending.earlyOrphanedCount ?? 0) > 0) && (
          <div className="flex items-center justify-between rounded border border-danger/40 bg-danger/5 p-3">
            <div className="text-xs">
              <div className="font-semibold text-danger">
                {data.pending.totalOrphanedAnyState ?? data.pending.orphanedFromPreviousBridge} orphaned demo command(s)
                {(data.pending.earlyOrphanedCount ?? 0) > 0
                  ? ` (incl. ${data.pending.earlyOrphanedCount} pre-dispatch)`
                  : ""}
              </div>
              <div className="text-txt-secondary">
                Bound to a previous bridge connection. Cancel them to clear the queue,
                then dispatch a fresh order so it binds to the active bridge.
              </div>
            </div>
            <Button
              variant="destructive"
              size="sm"
              disabled={cancelBusy}
              onClick={cancelOrphans}
              data-testid="btn-cancel-orphaned-demo"
            >
              {cancelBusy ? "Cancelling…" : "Cancel orphaned"}
            </Button>
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs">
          <div className="text-txt-secondary">EA heartbeat</div>
          <div data-testid="dbg-heartbeat">
            {data.bridge.heartbeatAgeSeconds != null
              ? `${data.bridge.heartbeatAgeSeconds}s ago`
              : "never"}{" "}
            <span className={data.bridge.heartbeatFresh ? "text-success" : "text-danger"}>
              ({data.bridge.heartbeatFresh ? "fresh" : "stale"})
            </span>
          </div>

          <div className="text-txt-secondary">EA account</div>
          <div data-testid="dbg-account">
            {data.bridge.accountLoginMasked ?? "—"} · type={data.bridge.accountType ?? "?"} · v
            {data.bridge.eaVersionReported ?? "?"}
          </div>

          <div className="text-txt-secondary">Last demo poll</div>
          <div className={consumerColor} data-testid="dbg-last-poll">
            {data.demoConsumer.lastPollAgeSeconds != null
              ? `${data.demoConsumer.lastPollAgeSeconds}s ago (${data.demoConsumer.lastPollOutcome})`
              : "NEVER — EA has not polled the DEMO channel"}
          </div>

          <div className="text-txt-secondary">Consumer active (last 60s)</div>
          <div className={consumerColor} data-testid="dbg-consumer-active">
            {String(data.demoConsumer.eaDemoConsumerActive)}
          </div>

          <div className="text-txt-secondary">Last dispatch sent (server)</div>
          <div data-testid="dbg-last-dispatch">
            {data.demoConsumer.lastDispatchSentAt
              ? new Date(data.demoConsumer.lastDispatchSentAt).toLocaleTimeString()
              : "—"}
          </div>

          <div className="text-txt-secondary">Last EA result</div>
          <div data-testid="dbg-last-result">
            {data.demoConsumer.lastResultAt
              ? `${new Date(data.demoConsumer.lastResultAt).toLocaleTimeString()} (${data.demoConsumer.lastResultOutcome})`
              : "—"}
          </div>

          <div className="text-txt-secondary">Pending SENT_TO_MT5_DEMO</div>
          <div data-testid="dbg-pending">
            {data.pending.sentToMt5DemoCount} total · pickupable={data.pending.pickupableByCurrentBridge}
            {data.pending.orphanedFromPreviousBridge > 0 ? (
              <span className="text-danger"> · orphaned={data.pending.orphanedFromPreviousBridge}</span>
            ) : null}
            {data.pending.oldestSentAt
              ? ` · oldest ${new Date(data.pending.oldestSentAt).toLocaleTimeString()}`
              : ""}
          </div>

          {data.lastTerminalCommand && (
            <>
              <div className="text-txt-secondary">Last terminal command</div>
              <div data-testid="dbg-last-terminal">
                {data.lastTerminalCommand.commandId.slice(0, 14)} · {data.lastTerminalCommand.status}
                {data.lastTerminalCommand.reason ? ` · ${data.lastTerminalCommand.reason}` : ""}
                {data.lastTerminalCommand.brokerTicket
                  ? ` · ticket=${data.lastTerminalCommand.brokerTicket}`
                  : ""}
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Centralized Master MT5 Bridge (Slice 1+2) ──────────────────────────────
// When the calling user resolves to SHARED_MASTER_MT5, render an info card
// that explains they trade through the platform master bridge — masked
// account, broker name, EA version, heartbeat age. Per-user EA install
// instructions become optional (the user does not need to install MT5
// themselves in shared-master mode). NEVER renders apiKeyHash, raw bridge
// tokens, tokenLast4 of the master, server name, or real account numbers.
type MeRoutingStatus = {
  ok: boolean;
  effectiveRoutingMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
  routedViaMaster: boolean;
  master: null | {
    brokerName: string | null;
    accountNumberMasked: string | null;
    eaVersion: string | null;
    heartbeatAgeSeconds: number | null;
    healthy: boolean;
    sharedMasterAccountId: number | null;
  };
};
function PlatformMasterBridgeCard() {
  const [s, setS] = useState<MeRoutingStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/me/routing-status", { credentials: "include" });
        if (!r.ok) return;
        const j = (await r.json()) as MeRoutingStatus;
        if (!cancelled) setS(j);
      } catch { /* silent */ }
    }
    void load();
    const t = setInterval(load, 8000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  if (!s || s.effectiveRoutingMode !== "SHARED_MASTER_MT5") return null;
  const m = s.master;
  return (
    <Card className="border-2 border-warning/40 bg-warning/5" data-testid="card-platform-master-bridge">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-warning">
          <Plug className="w-5 h-5" /> Platform Master Bridge Active
        </CardTitle>
        <CardDescription className="text-warning/80">
          You are routed through the ARX shared master demo bridge. You do
          NOT need to install your own MT5 to place demo trades. Your
          per-user virtual ledger keeps your trades isolated from other
          users. Current connected bridge is being used as the ARX Master
          Bridge. Live trading via the master bridge remains gated by the
          16-gate evaluator and the operator master-live switch.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Broker</div>
            <div className="font-medium">{m?.brokerName ?? "—"}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Account</div>
            <div className="font-mono">{m?.accountNumberMasked ?? "—"}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">EA version</div>
            <div className="font-mono">{m?.eaVersion ?? "—"}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Heartbeat</div>
            <div className="font-mono">
              {m?.heartbeatAgeSeconds == null
                ? "—"
                : `${m.heartbeatAgeSeconds}s ago`}
              {m?.healthy
                ? <Badge className="ml-2 bg-success/20 text-success">healthy</Badge>
                : <Badge variant="destructive" className="ml-2">stale</Badge>}
            </div>
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground pt-2 border-t border-warning/20">
          The master bridge's broker credentials, tokens, and full account
          number are never returned by this app. The fields above are the
          only safe, masked operator metadata your role is allowed to see.
        </div>
      </CardContent>
    </Card>
  );
}

export default function MT5SetupWizardPage() {
  const { toast } = useToast();
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [conn, setConn] = useState<ConnectionCheck | null>(null);
  const [bstat, setBstat] = useState<BrokerStatus | null>(null);
  const [acct, setAcct] = useState<BrokerAccount | null>(null);
  const [posCount, setPosCount] = useState<number | null>(null);
  const [ordCount, setOrdCount] = useState<number | null>(null);
  const [exampleToken, setExampleToken] = useState<string>("");
  const [refreshing, setRefreshing] = useState(false);

  async function refreshAll() {
    setRefreshing(true);
    const [s, c, b, a, p, o] = await Promise.all([
      jget<{ requiredSecrets: SecretsStatus["requiredSecrets"]; missingSecrets: string[]; readOnlyReady: boolean; liveTradingAllowedFlag: SecretsStatus["liveTradingAllowedFlag"]; provider: string }>("/api/broker/secrets-status"),
      jget<ConnectionCheck>("/api/broker/connection-check"),
      jget<BrokerStatus>("/api/broker/status"),
      jget<BrokerAccount>("/api/broker/account"),
      jget<{ count: number }>("/api/positions/live"),
      jget<{ count: number }>("/api/orders/live"),
    ]);
    setSecrets(s as SecretsStatus | null);
    setConn(c);
    setBstat(b);
    setAcct(a);
    setPosCount(p?.count ?? null);
    setOrdCount(o?.count ?? null);
    setRefreshing(false);
  }
  useEffect(() => { void refreshAll(); }, []);

  function generateToken() {
    // Browser-side only. Never sent to server. User must manually paste it.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    setExampleToken(Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(""));
  }

  function copyText(s: string, label: string) {
    if (!s) return;
    void navigator.clipboard.writeText(s).then(() => toast({ title: `${label} copied` }));
  }

  const heartbeatWaiting = !conn?.connected;
  const accountWaiting = !conn?.checks?.accountReadable;
  const liveLocked = true; // server-enforced; this page never unlocks it

  return (
    <div className="container mx-auto py-6 space-y-6 max-w-5xl">
      <PlatformMasterBridgeCard />
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Plug className="w-6 h-6" /> MT5 Bridge Setup Wizard</h1>
          <p className="text-sm text-muted-foreground">Five steps to connect your MetaTrader 5 to this app — read-only by design.</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="default" size="sm" data-testid="button-download-zip">
            <a href="/api/mt5/bridge-package/zip" download>
              <Download className="w-4 h-4 mr-2" /> Download MT5 Bridge Package (.zip)
            </a>
          </Button>
          <Button variant="outline" size="sm" onClick={refreshAll} disabled={refreshing} data-testid="button-refresh-status">
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? "animate-spin" : ""}`} /> Refresh status
          </Button>
        </div>
      </div>

      {/* Bridge Status Header — at-a-glance vitals: heartbeat, account
          type, env, EA version, last-seen. Replaces having to scroll
          through multiple cards to learn whether the EA is currently
          reachable. Pulls from the same /connection-state we already
          query above so nothing new is fetched. */}
      <Card className="border-2 border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
        <CardContent className="pt-4 pb-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <Plug className="w-5 h-5 text-primary" />
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Bridge</div>
                <div className="text-sm font-semibold flex items-center gap-2">
                  {conn?.connected ? (
                    <><span className="inline-block w-2 h-2 rounded-full bg-success animate-pulse" /> Connected</>
                  ) : (
                    <><span className="inline-block w-2 h-2 rounded-full bg-warning" /> Waiting for heartbeat</>
                  )}
                </div>
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Account type</div>
              <div className="text-sm font-mono">{conn?.environment === "demo" ? "DEMO" : conn?.environment ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Last heartbeat</div>
              <div className="text-sm font-mono">{conn?.lastCheckedAt ? new Date(conn.lastCheckedAt).toLocaleTimeString() : "—"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Open positions</div>
              <div className="text-sm font-mono">{posCount ?? "—"}</div>
            </div>
            <div className="ml-auto">
              <Badge className="bg-danger/15 text-danger border-danger/30">
                <Lock className="w-3 h-3 mr-1" />LIVE LOCKED · DEMO ONLY
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <OperatorSetupChecklistCard />

      <PerUserBridgeTokenCard />

      <DemoExecutionReadinessCard />

      <DemoExecutionControlCard />

      <DemoExecutionTestPanelCard />
      <OpenDemoPositionsCard />

      {/* Advanced bridge diagnostics — collapsed by default. The page is
          long; most users only need to see status + the controlled test.
          Power users (operators, support) can expand for the
          per-bridge-row debug card and the deeper diagnostics panel. */}
      <details className="rounded-md border border-border bg-muted/20" data-testid="mt5-advanced-debug">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium flex items-center gap-2 hover:bg-muted/40 rounded-md">
          <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180" />
          Advanced bridge diagnostics
          <span className="text-xs text-muted-foreground font-normal ml-1">(operator / support only)</span>
        </summary>
        <div className="px-4 pb-4 pt-2 space-y-4">
          <DemoBridgeDebugCard />
          <BridgeDiagnosticsPanel />
        </div>
      </details>

      <OneClickToggleCard />

      <BridgeV2FeedStatus />

      {/* Persistent safety banner — emerald (protected) instead of amber
          (warning). This is a *good* default for users: live trading is
          locked BY DESIGN. Red/amber felt like an error condition. */}
      <Card className="border-2 border-success/40 bg-success/5">
        <CardContent className="pt-4 flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 text-success mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-success">Bridge connection is read-only by design.</p>
            <p className="text-muted-foreground">
              This setup page only <strong>reads</strong> your account, positions, and orders. Live orders
              are never placed from here — they go through the trade ticket with full server-side safety
              checks and your explicit confirmation.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* EA v1.28 install — dedicated, anchorable section so the
          Trade Logs upgrade hint can deep-link straight here. v1.28 is a
          strict superset of v1.27 that additionally reports the broker's
          real close fill price on every CLOSE. */}
      <Card
        id="ea-v128-install"
        className="border-2 border-primary/30 bg-primary/5 scroll-mt-24"
        data-testid="card-ea-v128-install"
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-primary">
            <Download className="w-4 h-4" /> EA v1.28 install (recommended)
          </CardTitle>
          <CardDescription>
            v1.28 is a strict superset of v1.27. The only behavioural change is
            that on every successful CLOSE the EA reports the broker's real close
            fill price and executed volume — this unblocks deterministic P/L on
            closed live test cycles. No server-side change is required.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm space-y-3">
          <ol className="list-decimal pl-5 space-y-1.5 text-muted-foreground">
            <li>
              Save the delivered file as{" "}
              <code className="text-xs">ReplitMT5BridgeEA_v128.mq5</code> into{" "}
              <code className="text-xs">&lt;MT5 data folder&gt;/MQL5/Experts/</code>.
            </li>
            <li>
              Open it in MetaEditor → press <strong>F7</strong> to compile →
              confirm <strong>0 errors, 0 warnings</strong>.
            </li>
            <li>
              On the chart, remove the v1.27 EA and attach the v1.28 EA. Keep
              every input identical to your v1.27 setup (ServerBaseUrl,
              BridgeToken, EnableLiveExecution, MaxLiveLot, ReadOnlyMode, …).
            </li>
            <li>
              Verify the Experts tab shows{" "}
              <code className="text-xs">EA version=1.28</code> and a heartbeat ACK.
            </li>
          </ol>
          <div className="rounded border border-warning/40 bg-warning/20 p-2.5 text-xs text-warning flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              <strong>Allow Algo Trading caveat:</strong> MT5 has three independent
              AutoTrading switches — the terminal toolbar button, the per-EA
              Common-tab "Allow Algo Trading" checkbox, and Tools → Options →
              Expert Advisors → "Allow algorithmic trading". All three must be ON,
              otherwise <code className="text-[11px]">OrderSend</code> returns
              retcode <code className="text-[11px]">10027</code> even when every
              server-side gate has passed.
            </span>
          </div>
          <Button asChild variant="outline" size="sm" data-testid="button-v128-download-zip">
            <a href="/api/mt5/bridge-package/zip" download>
              <Download className="w-4 h-4 mr-2" /> Download MT5 Bridge Package (.zip)
            </a>
          </Button>
        </CardContent>
      </Card>

      {/* STEP 1 — explain */}
      <Card data-testid="card-step1">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><span className="text-xs bg-primary/20 text-primary rounded-full w-6 h-6 inline-flex items-center justify-center">1</span> What the MT5 bridge does</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2 text-muted-foreground">
          <p>The bridge is a small Expert Advisor (EA) that runs <strong>inside your MetaTrader 5 terminal</strong>. It calls this Replit app over HTTPS every few seconds to send:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>A heartbeat (proves MT5 is alive)</li>
            <li>Your account snapshot (balance, equity, margin, currency)</li>
            <li>Your open positions (ticket, symbol, side, lot, entry, SL/TP, profit)</li>
          </ul>
          <p>The bridge <strong>never sends</strong> your broker password. It <strong>never executes</strong> orders in v1 — even if a command is queued, the EA replies <code className="text-xs">EA_READ_ONLY_MODE_ACTIVE</code>.</p>
        </CardContent>
      </Card>

      {/* STEP 2 — secrets */}
      <Card data-testid="card-step2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><span className="text-xs bg-primary/20 text-primary rounded-full w-6 h-6 inline-flex items-center justify-center">2</span> <KeyRound className="w-4 h-4" /> Required Replit Secrets</CardTitle>
          <CardDescription>Set these in Tools → Secrets, then restart the API server workflow.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2">
            {[
              { k: "BROKER_PROVIDER", v: "mt5", required: true, why: "Selects the real MT5 provider instead of mock." },
              { k: "MT5_BRIDGE_TOKEN", v: "<your long random token>", required: true, why: "Shared secret between MT5 EA and this app." },
              { k: "MT5_ENVIRONMENT", v: "demo", required: false, why: "Informational. Use 'demo' until full read-only verification passes." },
              { k: "MT5_ACCOUNT_ID", v: "<optional>", required: false, why: "Account-id binding for audit trail." },
              { k: "LIVE_TRADING_ALLOWED", v: "false", required: false, why: "This flag alone NEVER enables live trading." },
            ].map((row) => {
              const presentInfo = secrets?.requiredSecrets.find(s => s.key === row.k);
              const isSet = presentInfo?.set ?? false;
              return (
                <div key={row.k} className="flex items-center gap-3 p-2 rounded border border-border bg-muted/30 text-sm">
                  <code className="font-mono font-semibold w-44 shrink-0">{row.k}</code>
                  <code className="font-mono text-xs text-muted-foreground flex-1 truncate">{row.v}</code>
                  {row.required ? <Badge variant="outline" className="text-xs">required</Badge> : <Badge variant="outline" className="text-xs opacity-60">optional</Badge>}
                  {presentInfo ? <YesNo v={isSet} yes="Set" no="Missing" /> : <Badge variant="outline" className="text-xs opacity-60">unknown</Badge>}
                </div>
              );
            })}
          </div>
          {secrets && secrets.missingSecrets.length > 0 && (
            <div className="text-sm text-warning flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> Missing required secrets: {secrets.missingSecrets.join(", ")}</div>
          )}
        </CardContent>
      </Card>

      {/* STEP 3 — generate token */}
      <Card data-testid="card-step3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><span className="text-xs bg-primary/20 text-primary rounded-full w-6 h-6 inline-flex items-center justify-center">3</span> Generate a private bridge token</CardTitle>
          <CardDescription>The example below is generated <strong>only in your browser</strong>. It is never sent to or stored by this server.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <code className="flex-1 px-3 py-2 bg-muted rounded text-sm font-mono break-all" data-testid="text-example-token">
              {exampleToken || "(click Generate to produce a 64-char hex token)"}
            </code>
            <Button size="sm" variant="outline" onClick={() => copyText(exampleToken, "Example token")} disabled={!exampleToken}>
              <Copy className="w-4 h-4" />
            </Button>
            <Button size="sm" onClick={generateToken} data-testid="button-generate-token">
              Generate Example Token
            </Button>
          </div>
          <div className="text-xs text-muted-foreground space-y-1">
            <p>1. Click <strong>Generate</strong>. A fresh 256-bit hex string appears above.</p>
            <p>2. Copy it. Paste it into Replit Secret <code>MT5_BRIDGE_TOKEN</code>.</p>
            <p>3. Paste the <strong>same value</strong> into the EA <code>BridgeToken</code> input.</p>
            <p>4. Restart the API server workflow so the new secret takes effect.</p>
            <p className="text-warning pt-1">Never paste the token into chat, screenshots, or git commits. Rotate it if it ever leaks.</p>
          </div>
        </CardContent>
      </Card>

      {/* STEP 4 — install */}
      <Card data-testid="card-step4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><span className="text-xs bg-primary/20 text-primary rounded-full w-6 h-6 inline-flex items-center justify-center">4</span> <Server className="w-4 h-4" /> Install the EA in MetaTrader 5</CardTitle>
          <CardDescription>Download the package above, then follow these steps inside MT5.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="text-sm space-y-1.5 list-decimal pl-5 text-muted-foreground">
            <li>Open MetaTrader 5.</li>
            <li>File → Open Data Folder.</li>
            <li>Open <code>MQL5</code> → <code>Experts</code>.</li>
            <li>Copy <code>ReplitMT5BridgeEA.mq5</code> from the ZIP into <code>Experts</code>.</li>
            <li>Open MetaEditor (refresh the Navigator if needed).</li>
            <li>Compile <code>ReplitMT5BridgeEA.mq5</code> (F7) — expect 0 errors.</li>
            <li>Return to MT5.</li>
            <li>Drag the EA onto any chart.</li>
            <li>Tick <strong>Allow Algo Trading</strong> on the Common tab.</li>
            <li>Tools → Options → Expert Advisors.</li>
            <li>Tick <strong>Allow WebRequest for listed URL</strong>.</li>
            <li>Add your Replit app base URL (e.g. <code>https://your-repl.replit.app</code>).</li>
            <li>Paste your <code>BridgeToken</code> into the EA inputs.</li>
            <li>Keep <code>ReadOnlyMode = true</code>.</li>
            <li>Keep <code>AllowOrderExecution = false</code>.</li>
            <li>Click OK to start the EA. Confirm the Algo Trading button at the top of MT5 is green.</li>
          </ol>
        </CardContent>
      </Card>

      {/* STEP 5 — connection check */}
      <Card data-testid="card-step5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><span className="text-xs bg-primary/20 text-primary rounded-full w-6 h-6 inline-flex items-center justify-center">5</span> <ListChecks className="w-4 h-4" /> Connection check</CardTitle>
          <CardDescription>Live status from the broker endpoints. Refresh after starting the EA.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-2">
            <Row label="Replit Secrets configured" value={<YesNo v={!!secrets?.readOnlyReady} />} />
            <Row label="Bridge provider" value={<code className="text-xs font-mono">{bstat?.status?.kind ?? "—"}</code>} />
            <Row label="Bridge connected" value={<YesNo v={!!conn?.connected} />} />
            <Row label="Environment" value={<code className="text-xs font-mono">{conn?.environment ?? "unknown"}</code>} />
            <Row label="MT5 account detected" value={<YesNo v={!!conn?.checks?.accountReadable} />} />
            <Row label="Account snapshot present" value={<YesNo v={!!acct?.account} />} />
            <Row label="Balance readable" value={<YesNo v={!!conn?.checks?.balanceReadable} />} />
            <Row label="Equity readable" value={<YesNo v={!!conn?.checks?.equityReadable} />} />
            <Row label="Margin readable" value={<YesNo v={!!conn?.checks?.marginReadable} />} />
            <Row label="Symbols readable" value={<YesNo v={!!conn?.checks?.symbolsReadable} />} />
            <Row label="Positions readable" value={<YesNo v={!!conn?.checks?.positionsReadable} />} />
            <Row label="Orders readable" value={<YesNo v={!!conn?.checks?.ordersReadable} />} />
            <Row label="Open positions" value={<code className="text-xs font-mono">{posCount ?? "—"}</code>} />
            <Row label="Open orders" value={<code className="text-xs font-mono">{ordCount ?? "—"}</code>} />
            <Row label="Read-only ready" value={<YesNo v={!!conn?.readOnlyReady} />} />
            <Row label="Live order execution" value={liveLocked ? (
              <Badge className="bg-danger/15 text-danger border-danger/30"><Lock className="w-3 h-3 mr-1" />locked</Badge>
            ) : (
              <Badge className="bg-success/15 text-success border-success/30">unlocked</Badge>
            )} />
          </div>

          <div className="mt-4 grid gap-2 text-xs text-muted-foreground">
            {heartbeatWaiting && <div className="flex items-center gap-2"><AlertTriangle className="w-3.5 h-3.5 text-warning" /> Heartbeat: <strong className="text-warning">waiting</strong> — start the EA on a chart to see this flip.</div>}
            {!heartbeatWaiting && <div className="flex items-center gap-2"><ShieldCheck className="w-3.5 h-3.5 text-success" /> Heartbeat received. Last check at {conn?.lastCheckedAt}.</div>}
            {accountWaiting && <div className="flex items-center gap-2"><AlertTriangle className="w-3.5 h-3.5 text-warning" /> Account data: <strong className="text-warning">waiting</strong> — make sure MT5 is logged into your broker.</div>}
            {conn?.errors && conn.errors.length > 0 && <div className="text-danger">errors: {conn.errors.join("; ")}</div>}
          </div>
        </CardContent>
      </Card>

      {/* Troubleshooting panel */}
      <Card data-testid="card-troubleshooting">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> Troubleshooting</CardTitle>
          <CardDescription>Common problems and quickest fixes. Full guide in the downloaded TROUBLESHOOTING.md.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm grid gap-3 sm:grid-cols-2">
          <Trouble title="A. No heartbeat">
            <li>EA not attached to a chart</li>
            <li>Algo Trading disabled (button must be green)</li>
            <li>WebRequest URL not allowed in MT5 Options</li>
            <li>Wrong Replit URL in EA inputs</li>
            <li>Wrong token (HTTP 401 in EA log)</li>
            <li>MT5 terminal closed / VPS off</li>
          </Trouble>
          <Trouble title="B. Secrets missing">
            <li>Add <code>BROKER_PROVIDER=mt5</code></li>
            <li>Add <code>MT5_BRIDGE_TOKEN</code></li>
            <li>Add <code>MT5_ENVIRONMENT=demo</code></li>
            <li>Restart the API server workflow afterwards</li>
          </Trouble>
          <Trouble title="C. Account not readable">
            <li>MT5 not logged into broker</li>
            <li>EA not running on a chart</li>
            <li>Broker connection offline (red indicator in MT5)</li>
            <li>Token mismatch on /sync-account</li>
          </Trouble>
          <Trouble title="D. WebRequest failing">
            <li>Replit URL not added to MT5 WebRequest allowlist</li>
            <li>Wrong endpoint URL (must NOT include /api)</li>
            <li>HTTPS required — http:// will fail</li>
            <li>Firewall / VPS outbound restriction</li>
          </Trouble>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between p-2 rounded border border-border bg-muted/30">
      <span className="text-sm text-muted-foreground">{label}</span>
      {value}
    </div>
  );
}
function Trouble({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-border p-3 bg-muted/20">
      <div className="font-semibold mb-1.5 text-sm">{title}</div>
      <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">{children}</ul>
    </div>
  );
}
